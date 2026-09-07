"use strict";
// Fixture devices for the object inventory, loaded into the ADAPTER process via
// `NODE_OPTIONS=--require`. The adapter knows nothing about this file.
//
// Why a TLS stub and not a fetch hook: this adapter talks HTTPS and WSS to real
// hardware and validates the HomeWizard CA plus the certificate CN. Nothing can
// answer it over plain HTTP, and a test seam in the production code is not on the
// table. So each fixture device gets its own local TLS server (HTTPS + WSS on one
// port), and `tls.connect` — the single point BOTH protocols go through — is
// redirected there. An address that is not a fixture is left alone and will fail
// to connect, so a forgotten route shows up instead of silently reaching the
// network.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const tls = require("node:tls");
const { execFileSync } = require("node:child_process");
const { WebSocketServer } = require("ws");

const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "inventory", "devices.json"), "utf8"));

/**
 * Run openssl, turning a missing binary into a message that says what is missing.
 *
 * @param {string[]} args openssl arguments.
 */
function openssl(args) {
  try {
    execFileSync("openssl", args, { stdio: "ignore" });
  } catch (err) {
    throw new Error(`openssl is required to build the fixture device certificates: ${err.message}`);
  }
}

/**
 * A throwaway certificate authority for this run.
 *
 * Certificate validation stays ON for the fixture devices — only the trust anchor
 * is swapped, because a local stub cannot hold a certificate signed by the real
 * HomeWizard CA. So the run still proves the adapter demands a valid chain; it
 * just trusts this CA instead of HomeWizard's.
 */
const CA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hw-inventory-ca-"));
const CA_KEY = path.join(CA_DIR, "ca.key");
const CA_CERT = path.join(CA_DIR, "ca.pem");
openssl([
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  CA_KEY,
  "-out",
  CA_CERT,
  "-days",
  "2",
  "-subj",
  "/CN=HomeWizard Fixture CA",
]);
const TEST_CA = fs.readFileSync(CA_CERT, "utf8");
process.on("exit", () => fs.rmSync(CA_DIR, { recursive: true, force: true }));

/**
 * Certificate for one fixture device, signed by the throwaway CA. The CN follows
 * the real format (`appliance/<type>/<serial>`) so the pairing flow's identity
 * cross-check passes and the run stays free of warnings.
 *
 * @param {string} cn Certificate common name.
 * @returns {{key: string, cert: string}} PEM key pair.
 */
function makeCert(cn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-inventory-"));
  const keyFile = path.join(dir, "key.pem");
  const csrFile = path.join(dir, "dev.csr");
  const certFile = path.join(dir, "cert.pem");
  // A slash separates the fields of -subj, so the slashes inside the CN are escaped.
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyFile,
    "-out",
    csrFile,
    "-subj",
    `/CN=${cn.replace(/\//g, "\\/")}`,
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    csrFile,
    "-CA",
    CA_CERT,
    "-CAkey",
    CA_KEY,
    "-CAcreateserial",
    "-out",
    certFile,
    "-days",
    "2",
  ]);
  const key = fs.readFileSync(keyFile, "utf8");
  const cert = fs.readFileSync(certFile, "utf8");
  fs.rmSync(dir, { recursive: true, force: true });
  return { key, cert };
}

/**
 * Read a request body as text.
 *
 * @param {import("node:http").IncomingMessage} req Request.
 * @returns {Promise<string>} The body.
 */
function readBody(req) {
  return new Promise(resolve => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

/**
 * Serve one fixture device over HTTPS + WSS.
 *
 * The port is picked by the OS: a fixed one would collide with a leftover server
 * from an interrupted run, and that collision showed up as the adapter simply
 * never starting. The routing table is filled in the `listening` callback, which
 * runs many ticks before the adapter has finished onReady and connects.
 *
 * @param {object} device One entry of the fixtures file.
 */
function startDevice(device) {
  const { key, cert } = makeCert(`appliance/${device.api.product_type.toLowerCase()}/${device.api.serial}`);
  // Mutable copies: PUT /api/system and PUT /api/batteries change them, exactly
  // like a real device, so a control write is answered with the new value.
  const system = { ...device.system };
  const batteries = device.batteries ? { ...device.batteries } : null;

  const server = https.createServer({ key, cert }, (req, res) => {
    /**
     * Answer with JSON.
     *
     * @param {number} status HTTP status code.
     * @param {unknown} body  Response body.
     */
    const send = (status, body) => {
      const payload = JSON.stringify(body ?? {});
      res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    };
    const url = (req.url || "").split("?")[0];

    void (async () => {
      if (req.method === "POST" && url === "/api/user") {
        // A real device answers 403 until its button is pressed; a fixture device
        // behaves like a device whose button was just pressed.
        return send(200, { token: `fixture-token-${device.api.serial}` });
      }
      if (req.method === "DELETE" && url === "/api/user") {
        return send(200, {});
      }
      if (req.method === "GET" && url === "/api") {
        return send(200, device.api);
      }
      if (req.method === "GET" && url === "/api/measurement") {
        return send(200, device.measurement);
      }
      if (req.method === "GET" && url === "/api/system") {
        return send(200, system);
      }
      if (req.method === "PUT" && url === "/api/system") {
        Object.assign(system, JSON.parse((await readBody(req)) || "{}"));
        return send(200, system);
      }
      if (req.method === "PUT" && (url === "/api/system/reboot" || url === "/api/system/identify")) {
        return send(200, {});
      }
      if (url === "/api/batteries") {
        if (!batteries) {
          return send(404, { error: { code: "not_found", description: "no batteries" } });
        }
        if (req.method === "PUT") {
          Object.assign(batteries, JSON.parse((await readBody(req)) || "{}"));
        }
        return send(200, batteries);
      }
      return send(404, { error: { code: "not_found", description: url } });
    })();
  });

  const wss = new WebSocketServer({ server, path: "/api/ws" });
  wss.on("connection", ws => {
    ws.send(JSON.stringify({ type: "authorization_requested" }));
    ws.on("message", raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "authorization") {
        ws.send(JSON.stringify({ type: "authorized", data: "ok" }));
        return;
      }
      if (msg.type !== "subscribe") {
        return;
      }
      // The adapter subscribes to the three topics separately; answer each one
      // with the payload that topic carries, which is what creates the objects.
      if (msg.data === "measurement") {
        ws.send(JSON.stringify({ type: "measurement", data: device.measurement }));
      } else if (msg.data === "system") {
        ws.send(JSON.stringify({ type: "system", data: system }));
      } else if (msg.data === "batteries" && batteries) {
        ws.send(JSON.stringify({ type: "batteries", data: batteries }));
      }
    });
  });

  server.on("error", err => {
    // Never throw from an event handler here: the adapter process would die
    // without a word and the harness would wait for a start that never comes.
    console.error(`[inventory-hook] fixture device ${device.ip} failed: ${err.message}`);
    process.exit(1);
  });
  server.listen(0, "127.0.0.1", () => {
    ROUTES.set(device.ip, server.address().port);
  });
}

/** Fixture IP → local port, filled as the servers come up. */
const ROUTES = new Map();
for (const device of FIXTURES.devices) {
  startDevice(device);
}

// The one place both HTTPS and WSS go through. Only fixture addresses are
// redirected — everything else keeps the adapter's real pinning, so a forgotten
// route fails to connect instead of quietly reaching the network.
//
// Certificate validation stays on: only the trust anchor is swapped for this
// run's CA. `checkServerIdentity` is replaced because the presented CN is
// `appliance/<type>/<serial>` — not a hostname — which is true of real devices
// too; the adapter's own per-device CN pin is exercised by the unit tests.
const originalConnect = tls.connect;
tls.connect = function patchedConnect(...args) {
  const options = args[0];
  if (options && typeof options === "object") {
    const port = ROUTES.get(options.host) ?? ROUTES.get(options.servername);
    if (port) {
      const redirected = {
        ...options,
        host: "127.0.0.1",
        port,
        servername: undefined,
        ca: TEST_CA,
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
      };
      return originalConnect.call(this, redirected, ...args.slice(1));
    }
  }
  return originalConnect.apply(this, args);
};
