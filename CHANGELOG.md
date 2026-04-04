# Changelog

## **WORK IN PROGRESS**

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

## 0.2.0 (2026-04-05)
- Fix WebSocket auth format (plain string token instead of object)
- Fix mDNS service type (`_homewizard._tcp` for API v2 instead of `_hwenergy._tcp`)
- Add editable IP column in Admin UI device table (empty = mDNS, set = fixed IP)
- Add manual IP pairing via `pairingIp` data point for networks without mDNS
- IP only stored in config when manually set (mDNS devices use automatic discovery)
- Add per-device remove button data point

## 0.1.3 (2026-04-04)
- mDNS discovery runs permanently (not just during pairing)
- Automatic IP updates when device IP changes (DHCP)

## 0.1.2 (2026-04-04)
- Bundle HomeWizard CA certificate for proper TLS validation
- Shared HTTPS agent for all connections

## 0.1.1 (2026-04-04)
- Add unit tests (129 tests)
- Fix Dependabot config

## 0.1.0 (2026-04-04)
- Initial release with API v2, WebSocket push, mDNS discovery, multi-device pairing
