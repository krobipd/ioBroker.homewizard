# ioBroker.homewizard

[![npm version](https://img.shields.io/npm/v/iobroker.homewizard)](https://www.npmjs.com/package/iobroker.homewizard)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dt/iobroker.homewizard)](https://www.npmjs.com/package/iobroker.homewizard)
![Installations](https://iobroker.live/badges/homewizard-installed.svg)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

<img src="https://raw.githubusercontent.com/krobipd/ioBroker.homewizard/main/admin/homewizard.svg" width="100" />

Real-time energy monitoring for [HomeWizard](https://www.homewizard.com) Energy devices with API v2.

---

## Features

- **HomeWizard API v2** — HTTPS + WebSocket, bearer-token authentication
- **mDNS pairing** — `_homewizard._tcp` discovery, press the device button to pair
- **WebSocket push** — measurements arrive ~1/s; REST polling takes over while the WebSocket reconnects
- **Plug-In Battery control** — charge/discharge mode and grid-feed permissions through the paired P1/kWh meter
- **Adaptive reconnect** — devices with weak WiFi switch to a faster reconnect interval and keep REST polling running so data keeps flowing
- **Encrypted device tokens** — stored per device object, no adapter restart on pairing or removal

---

## Requirements

- **Node.js >= 22**
- **ioBroker js-controller >= 7.0.7**
- **ioBroker Admin >= 7.8.23**
- **HomeWizard device with API v2 support** (firmware 4.x+ with local API enabled)

---

## Supported Devices

| Device | Product Type |
|--------|--------------|
| P1 Meter | HWE-P1 |
| kWh Meter 1-Phase | HWE-KWH1 (also sold as SDM230) |
| kWh Meter 3-Phase | HWE-KWH3 (also sold as SDM630) |
| Plug-In Battery | HWE-BAT |

The Plug-In Battery is paired separately and shows up as its own device. To control charge/discharge mode and grid-feed permissions, you write to the `battery.*` data points of the P1 or kWh meter — that's where HomeWizard exposes the battery commands.

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
    │   ├── wifi_rssi_db         — WiFi signal strength (number, dBm)
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
        ├── api_v1_enabled       — Toggle the device's deprecated v1 API (bool, R/W — leave off)
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
- Check `info.wifi_rssi_db` — above -75 dBm is comfortable, weaker than -85 dBm explains frequent drops
- For devices with weak WiFi the adapter switches to a faster reconnect interval (60 s instead of 5 min) and keeps REST polling in the background so you don't lose data
- A WebSocket-layer ping/pong heartbeat (~30 s ping, 10 s pong window) catches half-dead links where the TCP stream is buffered but the device has stopped responding. Such links are torn down and reconnected automatically — you no longer end up with a stale "connected" status while measurement values stop updating.
- IP changes are picked up via mDNS — no manual reconfiguration needed

### Token invalid after factory reset
- Set the device's `remove` data point to `true`, then pair again

---

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**

- Debug log now traces every HTTPS API call and device-state lifecycle — easier diagnostics for chronic bouncing or pairing/recovery issues.

### 0.7.7 (2026-05-13)

- Devices with chronically bad WiFi no longer flood the log: max one warn per hour when the device drops out, one info when it comes back. Full timeline stays at debug level.
- Internal reconnect-strategy adjustments (unstable / normal mode switches) moved from info to debug — not user-actionable.

### 0.7.6 (2026-05-12)

- The battery mode dropdown and the tariff state no longer crash the admin with "Error in GUI" when opened.

### 0.7.5 (2026-05-10)
- Half-dead connections are now detected and torn down — fixes cases where the device stopped responding but the adapter still showed "connected" with stale measurement values.
- The auth handshake now has a 45-second timeout — devices that accept the TCP connection but never reply to the auth protocol no longer hang forever.
- IP recovery and manual re-pair after factory reset no longer leave a dangling connection from before — switching to a new IP just works.
- Battery endpoint errors are no longer fully swallowed: 404 stays silent (device has no battery), other errors are visible in the debug log instead of being silently dropped.
- Manual pairing IP is validated as IPv4 up front — invalid input fails fast with a warning instead of a silent 60-second pairing timeout.
- A single corrupted device token can no longer take down the whole adapter — affected device is skipped with a re-pair hint, the others come up normally.
- Pairing supports multiple devices in one 60-second window: button-press additional devices and they are added one after the other instead of the session ending after the first.
- Various behind-the-scenes hardening — invisible if everything was already running fine, robustness if something is unstable.

### 0.7.4 (2026-05-09)
- Adapter log messages are now English only, in line with the ioBroker community standard. Localized state names, descriptions and dropdown labels (11 languages) are unchanged.

### 0.7.3 (2026-05-07)
- Less log spam when a device stays offline for longer periods — the initial `device unreachable` warning is enough; mDNS recovery attempts and offline-retry status now log at debug level only.

### Support Development

This adapter is free and open source. If you find it useful, consider buying me a coffee:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=for-the-badge&logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=for-the-badge)](https://paypal.me/krobipd)

---

Older entries are in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

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
