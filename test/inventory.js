"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller,
//   drive it with fixtures covering EVERY device type the adapter supports
//   (feedFixtures), then dump every <adapter>.0.* object to
//   test/objects.inventory.json in the ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is
//   set — pre-release.py exports the last tag's inventory): seed the previous
//   objects BEFORE start, start, feed, then assert that every object carries the
//   current name/desc/role/type/unit and that removed objects are gone.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
const VOLATILE = ["ts", "from", "user", "acl"];
// The device token is stored encrypted with the js-controller's `system.config.native.secret`
// (main.ts, encrypt/decrypt). That secret is minted per installation, so the ciphertext
// differs between two throwaway controllers — it is the one native value that can never be
// reproduced, and the inventory would flip with every fresh controller (measured 2026-09-15 in
// the first CI run of the start proof: four lines differed on the runner, and on the Mac after
// a fresh temp controller). The dump keeps the key and replaces the ciphertext with a marker.
const ENCRYPTED_NATIVE = ["encryptedToken"];
const ENCRYPTED_MARKER = "<encrypted with the installation secret>";
const COMPARED = ["name", "desc", "role", "type", "unit"];

const HOOK = path.join(__dirname, "inventory-hook.cjs");
const DEVICES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "inventory", "devices.json"), "utf8"),
).devices;

/**
 * The adapter's own object-ID rule: `<productType>_<serial>`, non-alphanumerics
 * replaced, lowercased (state-manager `sanitize`).
 *
 * @param {object} api The fixture device's `GET /api` payload.
 * @returns {string} Device object-ID prefix.
 */
function prefixOf(api) {
  const clean = s => s.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  return `${clean(api.product_type)}_${clean(api.serial)}`;
}

/**
 * Poll until a condition holds, or fail with a message that says what was missing.
 *
 * @param {string} what      What is being waited for (for the failure message).
 * @param {() => Promise<boolean>} check The condition.
 * @param {number} timeoutMs How long to wait.
 */
async function waitFor(what, check, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Store a value the way `adapter.decrypt` reads it back.
 *
 * Anything that does not start with `$/aes-192-cbc:` goes through js-controller's
 * legacy XOR against the system secret, and XOR is its own inverse — so the
 * fixture tokens can be written directly, without knowing anything the object
 * store does not already hold. Seeding a made-up "encrypted" string instead is
 * what broke the first attempt: `decrypt` turned it into bytes that cannot go
 * into an Authorization header, every REST call failed, and the inventory came
 * out without the `system` and `battery` branches.
 *
 * @param {string} secret The system secret from `system.config`.
 * @param {string} value  The plain value the adapter should end up with.
 * @returns {string} The stored form.
 */
function encryptLegacy(secret, value) {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    out += String.fromCharCode(secret.charCodeAt(i % secret.length) ^ value.charCodeAt(i));
  }
  return out;
}

/**
 * Put every fixture device into the object tree the way a paired installation
 * holds it. The pairing flow itself is covered by the unit tests; what this file
 * has to produce is the object inventory, and that is identical either way.
 *
 * @param {import("@iobroker/testing").TestHarness} harness The harness.
 */
async function seedDevices(harness) {
  const systemConfig = await harness.objects.getObjectAsync("system.config");
  const secret = systemConfig && systemConfig.native && systemConfig.native.secret;
  assert.ok(secret, "system.config carries no secret — cannot store fixture tokens");

  for (const device of DEVICES) {
    await harness.objects.setObjectAsync(`${NS}${prefixOf(device.api)}`, {
      type: "device",
      common: { name: device.api.product_name },
      native: {
        encryptedToken: encryptLegacy(secret, `fixture-token-${device.api.serial}`),
        productType: device.api.product_type,
        serial: device.api.serial,
        productName: device.api.product_name,
        ip: device.ip,
        certCn: `appliance/${device.api.product_type.toLowerCase()}/${device.api.serial}`,
      },
    });
  }
}

/**
 * Start the adapter with the fixture devices loaded into its process.
 *
 * @param {import("@iobroker/testing").TestHarness} harness The harness.
 */
async function startAdapter(harness) {
  await harness.changeAdapterConfig(ADAPTER, { native: {} });
  await seedDevices(harness);
  await harness.startAdapterAndWait(false, { NODE_OPTIONS: `--require ${HOOK}` });
}

/**
 * Wait until every fixture device has produced everything it can produce.
 *
 * The criterion is a STATE, never "the tree stopped growing": the devices come up
 * staggered, and a quiet moment early on would dump an inventory that is missing
 * exactly the data points this file exists for.
 *
 * @param {import("@iobroker/testing").TestHarness} harness The harness.
 */
async function feedFixtures(harness) {
  await waitFor("every fixture device to be online", async () => {
    const state = await harness.states.getStateAsync(`${NS}info.devicesOnline`);
    return Boolean(state && state.val === DEVICES.length);
  });
  for (const device of DEVICES) {
    const prefix = prefixOf(device.api);
    await waitFor(`${device.api.product_type} measurement`, async () =>
      Boolean(await harness.objects.getObjectAsync(`${NS}${prefix}.measurement.power_w`)),
    );
    // The system channel and its buttons come from the first system poll.
    await waitFor(`${device.api.product_type} system settings`, async () =>
      Boolean(await harness.objects.getObjectAsync(`${NS}${prefix}.system.identify`)),
    );
  }
  const battery = DEVICES.find(d => d.batteries);
  await waitFor("the battery branch", async () =>
    Boolean(await harness.objects.getObjectAsync(`${NS}${prefixOf(battery.api)}.battery.mode`)),
  );
}

/**
 * Dump every object of this instance in the object-structure bot's format.
 *
 * @param {import("@iobroker/testing").TestHarness} harness The harness.
 * @returns {Promise<Record<string, unknown>>} Sorted object map.
 */
async function dumpObjects(harness) {
  // The range starts at "<adapter>.0." — the instance root object itself is not part of the tree.
  const list = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of list.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const obj = { ...row.value };
    for (const key of VOLATILE) {
      delete obj[key];
    }
    if (obj.native) {
      obj.native = { ...obj.native };
      for (const key of ENCRYPTED_NATIVE) {
        if (typeof obj.native[key] === "string") {
          obj.native[key] = ENCRYPTED_MARKER;
        }
      }
    }
    out[row.id] = obj;
  }
  return out;
}

tests.integration(ADAPTER_DIR, {
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      before(async function () {
        this.timeout(180000);
        harness = getHarness();
        await startAdapter(harness);
        await feedFixtures(harness);
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });

      it("covers every product type the adapter supports", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        for (const device of DEVICES) {
          const prefix = `${NS}${prefixOf(device.api)}`;
          assert.ok(objects[prefix], `no objects for ${device.api.product_type} — the fixture did not reach it`);
        }
      });
    });

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(180000);
          harness = getHarness();
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          for (const [id, obj] of Object.entries(previous)) {
            await harness.objects.setObjectAsync(id, obj);
          }
          await startAdapter(harness);
          await feedFixtures(harness);
        });

        it("every current object carries the current texts and roles", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            if (got.type !== obj.type) {
              stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
            }
            for (const f of COMPARED) {
              if (JSON.stringify(got.common?.[f]) !== JSON.stringify(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
          }
          assert.deepStrictEqual(stale, [], `objects an update did not reach:\n${stale.join("\n")}`);
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], `leftover objects:\n${leftovers.join("\n")}`);
        });
      });
    }
  },
});
