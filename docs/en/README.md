# ioBroker.homewizard — User guide

Real-time energy data from HomeWizard Energy devices over the local **API v2**.

## Requirements

- A HomeWizard device that speaks API v2: **P1 Meter** (HWE-P1), **kWh Meter** 1-phase (HWE-KWH1 / SDM230) or 3-phase (HWE-KWH3 / SDM630), **Plug-In Battery** (HWE-BAT).
- Firmware new enough for the local API v2, and the local API switched on in the HomeWizard app.
- Node.js >= 22, js-controller >= 7.2.2, Admin >= 8.0.11.

Energy Socket, Watermeter and Energy Display speak only the deprecated v1 API. They are out of scope and will not be added.

## Adding a device

The adapter has no device table in its settings — devices live in the object tree and are added by pressing the button on the device itself.

**With automatic discovery (normal case)**

1. Open the **Objects** tab and set `homewizard.0.startPairing` to `true`.
2. Within 60 seconds, press the physical button on the HomeWizard device.
3. The device appears under the instance with its own folder.

The window stays open for the full 60 seconds, so several devices can be added in one go.

**With a fixed IP address** — for networks where mDNS does not get through (a separate VLAN, Docker without host networking):

1. Write the device's IP address into `homewizard.0.pairingIp`.
2. Then set `homewizard.0.startPairing` to `true` and press the button on the device.

## What you get

Each device gets a folder named `<product type>_<serial>` containing:

| Folder | Contents |
| --- | --- |
| `info` | Product name and type, firmware, WiFi network and signal strength, uptime, connection state |
| `measurement` | Power, voltage, current, frequency, energy totals per tariff, timestamps |
| `measurement.quality` | Voltage sags and swells, power failure counters (P1 only) |
| `measurement.external` | Gas, water and heat meters that report through the P1 meter |
| `system` | Cloud connection, status LED brightness, legacy v1 API, reboot and identify buttons |
| `battery` | Charge mode, permissions, target power and counters — on the meter the battery is paired with |

`remove` deletes a device including all of its data points.

## Connection states

- `<device>.info.connected` — true while the device answers the adapter. That includes the fallback polling, not just the real-time connection.
- `info.connection` — true while at least one device answers.
- `info.devicesTotal` / `info.devicesOnline` / `info.devicesAllOnline` — how many devices are set up and how many of them answer. `devicesTotal` keeps its value when the adapter is stopped.

Measurements normally arrive as a push about once per second. If that connection drops, the adapter polls over HTTPS instead (every 10 seconds, every 30 for a device with a weak signal) while it reconnects in the background, so the data keeps flowing.

## Controlling a Plug-In Battery

The battery is paired as its own device, but the controls sit on the **P1 or kWh meter** it works with — that is where HomeWizard exposes them:

- `battery.mode` — `zero`, `to_full`, `standby` or `predictive`.
- `battery.charge_to_full` — charge to 100 % once.
- `battery.permissions` — a JSON array, written as text.

`predictive` and `charge_to_full` need a recent battery firmware (API 2.3.0). Older firmware rejects them and the value is not applied.

## When something does not work

**Pairing does not find the device.** mDNS often does not cross VLANs or Docker bridges. Use the fixed-IP path above.

**Pairing fails right after the button press.** The adapter revokes the token it was issued and asks you to try again. Check that the local API is enabled in the HomeWizard app.

**A device shows as not connected.** The adapter never gives up: it retries the real-time connection with growing intervals (up to 5 minutes), searches for a changed IP address via mDNS about once an hour, and switches to a faster rhythm for devices it recognises as having a weak signal. A meter in a cellar hallway can be gone for hours; nothing needs to be done for it to come back.

**"token invalid — re-pair device to fix".** The device no longer accepts the adapter's token, usually after a factory reset. Pair it again — the existing data points are kept.

**Log lines about the bundled certificate expiring.** The adapter carries the HomeWizard CA certificate to verify device certificates. Well before it expires, an adapter update will ship a fresh one.

## Privacy and security

- Device tokens are stored encrypted in the device object, never in the adapter configuration.
- The adapter verifies each device's certificate against its known identity, so it will not talk to a different device that happens to hold a HomeWizard certificate.
- Removing a device also revokes the adapter's token on the device itself.
- Turning on `system.api_v1_enabled` re-enables the old v1 API on the device. That API has no encryption and no token — anyone on the network can then read and control the device. The adapter warns when you do it.
