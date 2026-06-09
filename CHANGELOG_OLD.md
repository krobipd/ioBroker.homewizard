# Older Changes
## 0.9.2 (2026-05-23)

- Changelog rewritten in user-centric style across all versions.

## 0.9.1 (2026-05-23)

- Internal cleanup. No user-facing changes.

## 0.9.0 (2026-05-22)

- User-modified state names are no longer overwritten on adapter restart

## 0.8.3 (2026-05-21)

- Improved error handling and stability.

---

## 0.8.2 (2026-05-19)

- Internal cleanup. No user-facing changes.

## 0.8.1 (2026-05-17)

- Internal cleanup. No user-facing changes.

## 0.8.0 (2026-05-17)

- Internal cleanup. No user-facing changes.

## 0.7.8 (2026-05-13)

- Improved debug logging for easier diagnosis of device connectivity and pairing issues.

## 0.7.7 (2026-05-13)

- Devices with chronically bad WiFi no longer flood the log: max one warn per hour when the device drops out, one info when it comes back. Full timeline stays at debug level.

## 0.7.6 (2026-05-12)

- The battery mode dropdown and the tariff state no longer crash the admin with "Error in GUI" when opened.

## 0.7.5 (2026-05-10)

- Half-dead connections are now detected and torn down — fixes cases where the device stopped responding but the adapter still showed "connected" with stale measurement values.
- The auth handshake now has a 45-second timeout — devices that accept the TCP connection but never reply to the auth protocol no longer hang forever.
- IP recovery and manual re-pair after factory reset no longer leave a dangling connection from before — switching to a new IP just works.
- Battery endpoint errors are no longer fully swallowed: 404 stays silent (device has no battery), other errors are visible in the debug log instead of being silently dropped.
- Manual pairing IP is validated as IPv4 up front — invalid input fails fast with a warning instead of a silent 60-second pairing timeout.
- A single corrupted device token can no longer take down the whole adapter — affected device is skipped with a re-pair hint, the others come up normally.
- Pairing supports multiple devices in one 60-second window: button-press additional devices and they are added one after the other instead of the session ending after the first.
- Various behind-the-scenes hardening — invisible if everything was already running fine, robustness if something is unstable.

## 0.7.4 (2026-05-09)

- Adapter log messages are now English only, in line with the ioBroker community standard. Localized state names, descriptions and dropdown labels (11 languages) are unchanged.

## 0.7.3 (2026-05-07)

- Less log spam when a device stays offline for longer periods — the initial `device unreachable` warning is enough; mDNS recovery attempts and offline-retry status now log at debug level only.

## 0.7.2 (2026-05-06)

- Internal hardening. No user-facing changes.

## 0.7.1 (2026-05-06)

- WiFi signal strength is now reported in dBm (was incorrectly labelled dB).
- Faster state updates on devices with high-frequency measurements.

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

- Improved crash resilience.
- Minimum js-controller requirement restored to 6.0.11 (was incorrectly raised to 7.0.0).

## 0.6.4 (2026-04-23)

- Internal hardening. No user-facing changes.

## 0.6.3 (2026-04-18)

- WebSocket and REST input hardening. Stops endless reconnect when the device token is invalid.

## 0.6.2 (2026-04-13)

- Fixed a potential hang during device communication errors. Safer adapter shutdown.

## 0.6.1 (2026-04-12)

- Internal cleanup. No user-facing changes.

## 0.6.0 (2026-04-11)

- Adaptive unstable mode: devices with bad WiFi reconnect faster (60s) and use persistent REST fallback.

## 0.5.1 (2026-04-08)

- Internal cleanup. No user-facing changes.

## 0.5.0 (2026-04-05)

- Robust reconnect: never gives up after WiFi loss, retries every 5 minutes. Periodic mDNS IP recovery (hourly).

## 0.4.2 (2026-04-05)

- Internal cleanup. No user-facing changes.

---

## 0.4.1 (2026-04-05)

- Measurement data moved into `measurement/` channel (cleaner object tree).

## 0.4.0 (2026-04-05)

- Online/offline status icon for devices.

## 0.3.5 (2026-04-05)

- Less log spam: repeated errors of the same kind are now shown once, then suppressed. Unreachable devices no longer get bombarded with requests.

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

- Internal cleanup. No user-facing changes.

## 0.1.0 (2026-04-04)

- Initial release. API v2, WebSocket push, mDNS discovery, multi-device pairing.
