# Older Changes
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
