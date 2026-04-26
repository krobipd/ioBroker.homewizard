# ioBroker.homewizard

[![npm version](https://img.shields.io/npm/v/iobroker.homewizard)](https://www.npmjs.com/package/iobroker.homewizard)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dt/iobroker.homewizard)](https://www.npmjs.com/package/iobroker.homewizard)
![Installations](https://iobroker.live/badges/homewizard-installed.svg)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

<img src="https://raw.githubusercontent.com/krobipd/ioBroker.homewizard/main/admin/homewizard.svg" width="100" />

Real-time energy monitoring from [HomeWizard](https://www.homewizard.com) Energy devices via API v2 with WebSocket push (~1 update/second).

---

## Features

- **WebSocket push** for real-time energy data (~1 update per second)
- **Automatic device discovery** via mDNS (zero configuration)
- **Hue-style pairing** — press the button on the device to connect
- **Multi-device support** — manage all HomeWizard devices in one adapter instance
- **Battery control** — manage HomeWizard Plug-In Batteries (mode, permissions)
- **System control** — LED brightness, cloud toggle, reboot, identify
- **REST fallback** — automatic polling when WebSocket is unavailable

---

## Requirements

- **Node.js >= 20**
- **ioBroker js-controller >= 6.0.11**
- **ioBroker Admin >= 7.6.20**
- **HomeWizard device with API v2 support** (firmware 4.x+ with local API enabled)

---

## Supported Devices

| Device | Product Type | WebSocket | Battery Control |
|--------|-------------|-----------|-----------------|
| P1 Meter | HWE-P1 | Yes | Yes (as controller) |
| kWh Meter 1-Phase | HWE-KWH1 / SDM230 | Yes | Yes (as controller) |
| kWh Meter 3-Phase | HWE-KWH3 / SDM630 | Yes | Yes (as controller) |
| Plug-In Battery | HWE-BAT | Yes | Controlled via P1/kWh |

---

## Configuration

### Prerequisites

The **local API** must be enabled on your HomeWizard device:

1. Open the **HomeWizard app** on your phone
2. Go to **Settings** > **Meters** > select your device > **Local API** > **Enable**

### Adding a device (automatic via mDNS)

1. Go to the **Objects** tab in ioBroker Admin
2. Set `homewizard.0.startPairing` to `true`
3. **Press the physical button** on your HomeWizard device within 60 seconds
4. The device is discovered automatically and appears under `homewizard.0`

### Adding a device (manual IP)

If mDNS is not available (e.g. different VLAN, Docker, or firewall blocking multicast):

1. Set `homewizard.0.pairingIp` to the IP address of your device
2. Set `homewizard.0.startPairing` to `true`
3. **Press the physical button** on the device within 60 seconds

### Managing devices

All paired devices are listed in the **Objects** tab under `homewizard.0`. Each device has its own folder (e.g. `hwe-p1_5c2fafaabbcc`) with measurement data, system settings, and device info.

- **Remove a device:** Set its `remove` data point to `true` — the device and all data points are deleted immediately
- **IP changes:** Detected automatically — after 3 failed reconnects, mDNS searches for the new IP. If not found, the device is marked offline

---

## State Tree

```
homewizard.0.
├── info.connection              — Overall connection status (bool)
├── startPairing                 — Activate pairing mode (button)
├── pairingIp                    — Device IP for manual pairing (string)
└── {productType}_{serial}/      — e.g. hwe-p1_5c2fafaabbcc
    ├── info/
    │   ├── productName          — Device name (string)
    │   ├── productType          — Product type (string)
    │   ├── firmware             — Firmware version (string)
    │   ├── connected            — WebSocket connection status (bool)
    │   ├── wifi_rssi_db         — WiFi signal strength (number, dB)
    │   └── uptime_s             — Device uptime (number, s)
    ├── measurement/             — Measurement data
    │   ├── power_w              — Total power (number, W)
    │   ├── power_l1_w .. l3_w   — Power per phase (number, W)
    │   ├── voltage_v            — Voltage single-phase (number, V)
    │   ├── voltage_l1_v .. l3_v — Voltage per phase (number, V)
    │   ├── current_a            — Current single-phase (number, A)
    │   ├── current_l1_a .. l3_a — Current per phase (number, A)
    │   ├── frequency_hz         — Grid frequency (number, Hz)
    │   ├── energy_import_kwh    — Total import (number, kWh)
    │   ├── energy_import_t1..t4_kwh — Import per tariff (number, kWh)
    │   ├── energy_export_kwh    — Total export (number, kWh)
    │   ├── energy_export_t1..t4_kwh — Export per tariff (number, kWh)
    │   ├── tariff               — Active tariff (number)
    │   ├── state_of_charge_pct  — Battery charge level (number, %)
    │   ├── cycles               — Battery charge cycles (number)
    │   ├── average_power_15m_w  — 15-min average power (number, W, Belgium)
    │   ├── monthly_power_peak_w — Monthly power peak (number, W, Belgium)
    │   ├── monthly_power_peak_timestamp — Monthly peak timestamp (string)
    │   ├── meter_model          — Meter model identifier (string)
    │   ├── timestamp            — Measurement timestamp (string)
    │   ├── quality/             — Power quality counters
    │   │   ├── voltage_sag_l1..l3_count
    │   │   ├── voltage_swell_l1..l3_count
    │   │   ├── power_fail_count
    │   │   └── long_power_fail_count
    │   └── external/            — External meters (gas, water, heat)
    │       └── {type}_{id}/
    │           ├── value        — Meter reading (number)
    │           ├── unit         — Unit (string)
    │           └── timestamp    — Last update (string)
    ├── battery/                 — Battery control (if batteries connected)
    │   ├── mode                 — zero / to_full / standby (string, R/W)
    │   ├── permissions          — JSON array (string, R/W)
    │   ├── battery_count        — Connected batteries (number)
    │   ├── power_w              — Battery power (number, W)
    │   ├── target_power_w       — Target power (number, W)
    │   ├── max_consumption_w    — Max consumption (number, W)
    │   └── max_production_w     — Max production (number, W)
    ├── remove                   — Remove device (button)
    └── system/                  — System settings
        ├── cloud_enabled        — Cloud communication (bool, R/W)
        ├── status_led_brightness_pct — LED brightness 0-100 (number, R/W)
        ├── api_v1_enabled       — Legacy API v1 (bool, R/W)
        ├── reboot               — Reboot device (button)
        └── identify             — Blink LED (button)
```

> States are created dynamically based on what the device reports. Not all devices have all states. kWh meters additionally provide apparent/reactive current, apparent/reactive power, and power factor states.

---

## Troubleshooting

### Device not found during pairing
- Make sure the device is on the same network/VLAN as the ioBroker server
- Verify that **local API** is enabled in the HomeWizard app (Settings > Meters > your device > Local API)
- Check that multicast/mDNS traffic is not blocked by your router/firewall

### WebSocket keeps disconnecting
- Check WiFi signal strength (`info.wifi_rssi_db`) — consider moving the device closer to the router
- The adapter automatically detects unstable connections (e.g. P1 meter in a basement) and switches to faster reconnect (60s instead of 5 min) with persistent REST fallback
- The adapter never gives up: reconnects with exponential backoff, falls back to REST polling, and periodically retries mDNS in case the IP changed

### Token invalid after factory reset
- Set the device's `remove` data point to `true`, then pair again

---

## Changelog
### 0.6.5 (2026-04-26)
- Process-level `unhandledRejection` / `uncaughtException` handlers added as last-line-of-defence against fire-and-forget rejections.
- Stop shipping the `manual-review` release-script plugin — adapter-only consequence.
- Audit-driven boilerplate sync with the other krobi adapters (`.vscode` json5 schemas, `tsconfig.test` looser test rules).
- Min js-controller correction: was `>=7.0.0`, restored to repochecker-recommended `>=6.0.11` (Source: `ioBroker.repochecker/lib/M1000_IOPackageJson.js`).
- `@types/iobroker` bumped to `^7.1.1`.

### 0.6.4 (2026-04-23)
- Separate test-build output (`build-test/`) from production `build/`, so `npm test` no longer risks leaving duplicated `build/src` + `build/test` trees in the published package.
- Wrap async `onReady` and `onStateChange` handlers with `.catch()` to prevent unhandled promise rejections from SIGKILLing the adapter.
- Declare `pairingIp` as an instance object (11-language name) instead of creating it dynamically in `onReady`.

### 0.6.3 (2026-04-18)
- Harden WebSocket and REST input handling against unexpected API responses
- Stop endless reconnect when the device token is invalid (fires once after 3 failed auth attempts)
- Avoid creating an empty `external/` channel when a device reports no external meters

### 0.6.2 (2026-04-13)
- Fix hanging promise when response stream errors mid-transfer (`res.on("error")`)
- Fix onUnload: wrap in try/finally so callback always fires (prevents adapter hang on shutdown)
- Optimize state creation hot path: use `setObjectNotExistsAsync` instead of `extendObjectAsync` (~50 fewer object writes per second per device)
- Remove unnecessary `removeDeviceFromObject` wrapper (DRY)

### 0.6.1 (2026-04-12)
- Code cleanup: extract testable connection-utils module (classifyError, createDeviceConnection)
- Add 20 unit tests for error classification, connection factory, and unstable threshold
- Fix ESLint warnings, remove unused devDependencies, remove duplicate scripts
- Add `@typescript-eslint/no-floating-promises` lint rule

## Support

- [ioBroker Forum](https://forum.iobroker.net/)
- [GitHub Issues](https://github.com/krobipd/ioBroker.homewizard/issues)

### Support Development

This adapter is free and open source. If you find it useful, consider buying me a coffee:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=for-the-badge&logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=for-the-badge)](https://paypal.me/krobipd)

---

## License

MIT License

Copyright (c) 2026 krobi <krobi@power-dreams.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

*Developed with assistance from Claude.ai*
