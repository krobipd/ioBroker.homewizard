# Changelog

## **WORK IN PROGRESS**

## 0.1.3 (2026-04-04)
- Remove IP from device config — devices are now discovered via mDNS at runtime
- mDNS discovery runs permanently (not just during pairing)
- Automatic IP updates when device IP changes (DHCP)
- Remove IP column from Admin UI device table
- Add `noAdd` to device table (devices can only be added via pairing)

## 0.1.2 (2026-04-04)
- Bundle HomeWizard CA certificate for proper TLS validation (like Home Assistant integration)
- Replace `rejectUnauthorized: false` with CA-based cert chain validation
- Shared HTTPS agent for all connections

## 0.1.1 (2026-04-04)
- Add unit tests (129 tests: API error, discovery, WebSocket, state manager, package)
- Fix Dependabot config (open-pull-requests-limit: 15, remove fixed schedule time)

## 0.1.0 (2026-04-04)
- Initial release
- HomeWizard API v2 with Bearer Token authentication
- WebSocket push for real-time energy data (~1/s)
- mDNS device discovery (`_hwenergy._tcp`)
- Hue-style multi-device pairing (physical button press)
- Supported devices: P1 Meter, kWh Meter (1-phase & 3-phase), Plug-In Battery
- Battery control (mode, permissions) via P1/kWh Meter
- System settings (LED brightness, cloud, API v1 toggle)
- REST fallback when WebSocket unavailable
