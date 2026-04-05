# Changelog (older entries)

For recent changes see [CHANGELOG.md](CHANGELOG.md).

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
