# Older Changes
## 0.7.4 (2026-05-09)
- Adapter log messages are now English only, in line with the ioBroker community standard. Localized state names, descriptions and dropdown labels (11 languages) are unchanged.

## 0.7.3 (2026-05-07)
- Less log spam when a device stays offline for longer periods — the initial `device unreachable` warning is enough; mDNS recovery attempts and offline-retry status now log at debug level only.

## 0.7.2 (2026-05-06)
- Internal hardening: stricter number parsing for sensor inputs, parallel state writes, code split for testability, 38 new tests covering the HTTPS client. No user-facing changes.

## 0.7.1 (2026-05-06)
- WiFi signal strength is now reported in dBm (was incorrectly labelled `dB`).
- Faster state updates: existence checks for datapoints are cached after first creation, saving ~30 Redis lookups per second on a P1 Meter pushing 1 measurement/second.

## 0.7.0 (2026-05-06)
- Adapter texts now follow your ioBroker system language: datapoint names, descriptions, and dropdown values for `tariff` and `battery.mode` in 11 languages (EN, DE, RU, PT, NL, FR, IT, ES, PL, UK, ZH-CN).
- Power-quality and Belgian capacity-tariff datapoints carry inline descriptions — hover in admin to see what each one means.
- Battery inputs are checked up-front: an unknown `battery.mode` or malformed `battery.permissions` JSON gives a clear warning instead of a cryptic error.
- Minimum requirements: Node.js 22 and ioBroker Admin 7.8.23.

## 0.6.7 (2026-05-01)
- Internal cleanup. No user-facing changes.
- Documentation: rewrote release notes for v0.6.0–v0.6.6 in user-friendly style across all languages.

## 0.6.6 (2026-04-28)
- Internal cleanup. No user-facing changes.

## 0.6.5 (2026-04-26)
- Crash defense: process-level error handlers.
- Min `js-controller` restored to `>=6.0.11` (was incorrectly `>=7.0.0`).

## 0.6.4 (2026-04-23)
- Internal hardening. No user-facing changes.

## 0.6.3 (2026-04-18)
- WebSocket and REST input hardening. Stops endless reconnect when the device token is invalid.

## 0.6.2 (2026-04-13)
- Fix: hanging promise on response stream errors. Safer adapter shutdown.

## 0.6.1 (2026-04-12)
- Internal cleanup. No user-facing changes.

## 0.6.0 (2026-04-11)
- Adaptive unstable mode: devices with bad WiFi reconnect faster (60s) and use persistent REST fallback.

## 0.5.1 (2026-04-08)
- Internal cleanup. No user-facing changes.

## 0.5.0 (2026-04-05)
- Robust reconnect: never gives up after WiFi loss, retries every 5 minutes. Periodic mDNS IP recovery (hourly).

## 0.4.2 (2026-04-05)
- Internal: consistent donation labels.

---

## 0.4.1 (2026-04-05)
- Measurement data moved into `measurement/` channel (cleaner object tree).

## 0.4.0 (2026-04-05)
- Online/offline status icon for devices.

## 0.3.5 (2026-04-05)
- Fix log spam: error deduplication by category. REST fallback stops on network errors.

## 0.3.4 (2026-04-05)
- mDNS only active during pairing. Automatic IP recovery after 3 failed reconnects.

## 0.3.3 (2026-04-05)
- Fix mDNS pairing: restart browser on pairing start (cached devices were not re-announced).

## 0.3.2 (2026-04-05)
- Admin UI restructured. README updated with prerequisites and manual IP pairing.

## 0.3.1 (2026-04-05)
- Fix: uncaught exception on device removal (late WebSocket frames).

## 0.3.0 (2026-04-05)
- **Breaking:** Device config stored per device instead of adapter native. Auto-migration. No adapter restart on pairing or device removal. Auth backoff after 3 failed attempts.

## 0.2.0 (2026-04-05)
- Fix WebSocket auth format and mDNS service type for API v2. Manual IP pairing for networks without mDNS.

## 0.1.3 (2026-04-04)
- mDNS discovery now permanent. Automatic IP updates on DHCP changes.

## 0.1.2 (2026-04-04)
- HomeWizard CA certificate bundled for proper TLS validation.

## 0.1.1 (2026-04-04)
- Internal: 129 unit tests added.

## 0.1.0 (2026-04-04)
- Initial release. API v2, WebSocket push, mDNS discovery, multi-device pairing.
