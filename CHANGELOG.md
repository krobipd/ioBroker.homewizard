# Changelog

## **WORK IN PROGRESS**

## 0.4.1 (2026-04-05)
- Move measurement data into `measurement/` channel (cleaner object tree structure)
- Cleanup logic removes old datapoints from device root on adapter start

## 0.4.0 (2026-04-05)
- Add online/offline status icon for devices in object tree (`statusStates`)

## 0.3.5 (2026-04-05)
- Fix log spam: error deduplication by category (NETWORK/TIMEOUT/AUTH), not by context
- REST fallback stops polling on network errors (no more hammering unreachable devices)
- System poll only runs for WebSocket-connected devices
- Error classification follows beszel/parcelapp pattern (`classifyError()`)

## 0.3.4 (2026-04-05)
- mDNS only active during pairing (not permanently at adapter start)
- Always store device IP on pairing (no dependency on mDNS for normal operation)
- Automatic IP recovery: after 3 failed reconnects, mDNS searches for new IP (one attempt, then offline)
- Device marked offline with clear log message when unreachable and mDNS finds nothing

## 0.3.3 (2026-04-05)
- Fix mDNS pairing: restart browser on pairing start (cached devices were not re-announced)
- Improve log messages during pairing (clearer user instructions)

## 0.3.2 (2026-04-05)
- Improve Admin UI: structured sections for prerequisites, automatic/manual pairing, device management
- Improve README: detailed configuration guide with prerequisites and manual IP pairing

Older entries: [CHANGELOG_OLD.md](CHANGELOG_OLD.md)
