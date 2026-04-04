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

Real-time energy monitoring from HomeWizard devices via API v2 with WebSocket push (~1 update/second).

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
- **ioBroker js-controller >= 7.0.0**
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

> **Note:** Energy Socket (HWE-SKT) and Watermeter (HWE-WTR) only support API v1 and are not yet supported. Support will be added when HomeWizard releases API v2 for these devices.

---

## Configuration

Devices are added via the **pairing mode**, not manually:

1. Open the **Objects** tab in ioBroker Admin
2. Set `homewizard.0.startPairing` to `true`
3. **Press the physical button** on your HomeWizard device within 60 seconds
4. The device is discovered automatically and appears in the adapter settings

The Admin UI shows all paired devices. You can update the IP address if a device gets a new one.

---

## State Tree

```
homewizard.0.
├── info.connection              — Overall connection status (bool)
├── startPairing                 — Activate pairing mode (button)
└── {productType}_{serial}/      — e.g. hwe-p1_5c2fafaabbcc
    ├── info/
    │   ├── productName          — Device name (string)
    │   ├── productType          — Product type (string)
    │   ├── firmware             — Firmware version (string)
    │   ├── connected            — WebSocket connection status (bool)
    │   ├── wifi_rssi_db         — WiFi signal strength (number, dB)
    │   └── uptime_s             — Device uptime (number, s)
    ├── power_w                  — Total power (number, W)
    ├── power_l1_w .. l3_w       — Power per phase (number, W)
    ├── voltage_l1_v .. l3_v     — Voltage per phase (number, V)
    ├── current_l1_a .. l3_a     — Current per phase (number, A)
    ├── frequency_hz             — Grid frequency (number, Hz)
    ├── energy_import_kwh        — Total import (number, kWh)
    ├── energy_import_t1..t4_kwh — Import per tariff (number, kWh)
    ├── energy_export_kwh        — Total export (number, kWh)
    ├── energy_export_t1..t4_kwh — Export per tariff (number, kWh)
    ├── tariff                   — Active tariff (number)
    ├── quality/                 — Power quality counters
    │   ├── voltage_sag_l1..l3_count
    │   ├── voltage_swell_l1..l3_count
    │   ├── power_fail_count
    │   └── long_power_fail_count
    ├── external/                — External meters (gas, water, heat)
    │   └── {type}_{id}/
    │       ├── value            — Meter reading (number)
    │       ├── unit             — Unit (string)
    │       └── timestamp        — Last update (string)
    ├── battery/                 — Battery control (if batteries connected)
    │   ├── mode                 — zero / to_full / standby (string, R/W)
    │   ├── permissions          — JSON array (string, R/W)
    │   ├── battery_count        — Connected batteries (number)
    │   ├── power_w              — Battery power (number, W)
    │   ├── target_power_w       — Target power (number, W)
    │   ├── max_consumption_w    — Max consumption (number, W)
    │   └── max_production_w     — Max production (number, W)
    └── system/                  — System settings
        ├── cloud_enabled        — Cloud communication (bool, R/W)
        ├── status_led_brightness_pct — LED brightness 0-100 (number, R/W)
        ├── api_v1_enabled       — Legacy API v1 (bool, R/W)
        ├── reboot               — Reboot device (button)
        └── identify             — Blink LED (button)
```

> States are created dynamically based on what the device reports. Not all devices have all states.

---

## Troubleshooting

### Device not found during pairing
- Make sure the device is on the same network/VLAN as the ioBroker server
- Verify that **local API** is enabled in the HomeWizard app (Settings > Meters > your device > Local API)
- Check that multicast/mDNS traffic is not blocked by your router/firewall

### WebSocket keeps disconnecting
- Check WiFi signal strength (`info.wifi_rssi_db`) — consider moving the device closer to the router
- The adapter automatically reconnects with exponential backoff and falls back to REST polling

### Token invalid after factory reset
- Remove the device from the adapter settings and pair again

---

## Changelog

### 0.3.1 (2026-04-05)
- Fix uncaught exception on device removal (invalid WebSocket frame during close)

### 0.3.0 (2026-04-05)
- Store device config in device objects (no adapter restart on pairing/remove)
- Fix datapoint issues (startPairing, pairingIp, button states)
- Reconnect workflow: IP change handling, auth backoff, error dedup

### 0.2.0 (2026-04-05)
- Fix WebSocket auth format and mDNS service type (`_homewizard._tcp`)
- Add editable IP column in Admin UI (empty = mDNS, set = fixed IP)
- Add manual IP pairing for networks without mDNS

### 0.1.3 (2026-04-04)
- mDNS discovery runs permanently, automatic IP updates

### 0.1.2 (2026-04-04)
- Bundle HomeWizard CA certificate for proper TLS validation

### 0.1.1 (2026-04-04)
- Add unit tests (129 tests)

### 0.1.0 (2026-04-04)
- Initial release with API v2, WebSocket push, mDNS discovery, multi-device pairing

Older changelog: [CHANGELOG.md](CHANGELOG.md)

---

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
