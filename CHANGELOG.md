# Changelog

## **WORK IN PROGRESS**

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
