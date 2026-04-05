# Changelog

## **WORK IN PROGRESS**

## 0.4.0 (2026-04-05)
- Add online/offline status icon for devices in object tree (`statusStates`)
- Add `data/` folder with example object dump (P1 Meter) for repository review

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

## 0.3.1 (2026-04-05)
- Fix uncaught exception on device removal (WS_ERR_INVALID_OPCODE from late frames)
- Use `terminate()` instead of `close()` for immediate WebSocket cleanup

## 0.3.0 (2026-04-05)
- **Breaking:** Device config stored in device objects instead of adapter native (auto-migration)
- No adapter restart on pairing or device removal
- Fix `startPairing` not resetting to false after pairing
- Fix `pairingIp` not clearing after use
- Fix buttons (`remove`, `reboot`, `identify`) having null state and wrong `read:true`
- Skip battery channel when no batteries connected (battery_count=0)
- Close WebSocket on IP change (mDNS) and reconnect immediately with new IP
- Auth backoff: stop reconnecting after 3 failed auth attempts
- Error dedup: repeated errors logged as debug, connection restored as info
- System poll only for connected devices

Older entries: [CHANGELOG_OLD.md](CHANGELOG_OLD.md)
