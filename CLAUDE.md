# CLAUDE.md — ioBroker.homewizard

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker HomeWizard Adapter** — Echtzeit-Energiedaten via API v2 mit WebSocket-Push (~1/s).

- **Version:** 0.6.6 (2026-04-28 — Audit-Cleanup gegen ioBroker.example/TypeScript-Vollstandard)
- **GitHub:** https://github.com/krobipd/ioBroker.homewizard
- **npm:** https://www.npmjs.com/package/iobroker.homewizard
- **Repository PR:** ioBroker/ioBroker.repositories#5749
- **Runtime-Deps:** `@iobroker/adapter-core`, `ws`, `bonjour-service`
- **Test-Setup:** offizieller ioBroker.example/TypeScript-Standard — Tests unter `src/**/*.test.ts` direkt mit `ts-node/register`, kein separater Build (siehe globales `reference_iobroker_test_setup_standard`)
- **`@types/node` an `engines.node`-Min gekoppelt:** `^20.x` weil `engines.node: ">=20"`. Dependabot ignoriert Major-Bumps

## API v2 Referenz

**Offizielle Doku:** https://api-documentation.homewizard.com/docs/category/api-v2

- HTTPS (self-signed) + WSS, Auth via Bearer Token
- Header: `X-Api-Version: 2`
- Pairing: `POST /api/user` → 403 bis physischer Button gedrückt → 200 + Token
- WebSocket: `wss://<IP>/api/ws` → auth → subscribe `measurement` → Push ~1/s
- Endpoints: `/api` (info), `/api/user` (CRUD), `/api/measurement`, `/api/system`, `/api/batteries`, `/api/ws`

## Architektur

```
src/main.ts                  → Adapter (Lifecycle, Pairing, Multi-Device, Reconnect)
src/lib/types.ts             → Interfaces
src/lib/connection-utils.ts  → classifyError, createDeviceConnection (pure, testbar)
src/lib/cacert.ts            → HomeWizard CA-Cert + shared HTTPS Agent
src/lib/discovery.ts         → mDNS (_homewizard._tcp), nur bei Pairing/IP-Recovery
src/lib/homewizard-client.ts → HTTPS-Client (REST)
src/lib/websocket-client.ts  → WSS-Client (Echtzeit)
src/lib/state-manager.ts     → State CRUD + Cleanup
```

## Design-Entscheidungen

1. **Multi-Device Single-Instance** (wie hueemu)
2. **Hue-Style Pairing** — mDNS Discovery → User drückt physischen Knopf → Token
3. **WebSocket primär** — Push ~1/s, REST-Fallback (10s poll bei WS-Disconnect, stoppt bei NETWORK-Error)
4. **bonjour-service** für mDNS (`_homewizard._tcp` v2), nur bei Pairing und IP-Recovery
5. **API v2 only** — v1 unsicher, kein WS, deprecated
6. **Device-Config in Device-Objekten** (seit v0.3.0) — Token mit `this.encrypt()`, KEIN adapter native → kein Restart bei Pairing/Remove
7. **TLS mit CA-Cert** — HomeWizard CA gebündelt, Hostname-Check übersprungen (CN = `appliance/type/serial`)
8. **Admin UI ohne Gerätetabelle** — Geräte im Objekte-Tab, nicht in Config
9. **statusStates** (seit v0.4.0) — Device-Objekte haben `statusStates.onlineId` → grün/grau Icon im Objektbaum
10. **measurement/ Channel** (seit v0.4.0) — Messdaten unter `measurement/`, nicht lose im Device-Root. `cleanupMovedStates()` räumt alte Pfade auf

## Error-Handling (seit v0.3.5)

Folgt beszel/parcelapp Pattern:
- **`classifyError()`** → Kategorien: NETWORK, TIMEOUT, AUTH, HTTP_xxx, UNKNOWN
- **Dedup per Device:** `lastErrorCode` = Kategorie (NICHT `${context}:${code}`)
- **Erster Fehler** = warn, **Wiederholung** = debug, **Recovery** = info "connection restored"
- **REST-Fallback stoppt** bei NETWORK-Error (kein Bombardieren unerreichbarer Geräte)
- **System-Poll** nur für WS-verbundene Geräte

## Reconnect-Workflow (seit v0.5.0)

1. WS disconnected → warn einmal → REST-Fallback + WS-Reconnect (exponential backoff, max 5 min)
2. REST bekommt NETWORK-Error → REST stoppt (WS-Reconnect läuft weiter)
3. Nach 3 WS-Failures → mDNS IP-Recovery (60s Timeout)
4. mDNS findet neue IP → Update + Reconnect
5. mDNS findet nichts → **WS-Reconnect läuft weiter** (alle 5 min), mDNS-Retry ~stündlich
6. **Adapter gibt NIE auf** — designed für Geräte mit schlechtem WiFi (stundenlange Ausfälle)
7. Auth-Backoff: nach 3 Auth-Failures Stopp, warn "token invalid — re-pair"
8. **Nur WS steuert `info.connected`** — REST-Fallback liefert Daten, flippt aber nicht den Online-Status

## Adaptive Unstable-Mode (seit v0.6.0)

Erkennt automatisch Geräte mit instabilem WiFi (z.B. P1 Meter im Kellerflur) und passt die Reconnect-Strategie pro Gerät an.

**Erkennung:** Wenn ein Gerät sich verbindet und innerhalb von 10 Minuten (`STABLE_THRESHOLD_MS`) wieder disconnected, zählt das als "instabil". Nach 3 solchen kurzen Verbindungen (`UNSTABLE_DISCONNECT_THRESHOLD`) wechselt der Adapter in den Unstable-Modus für dieses Gerät.

**Unstable-Modus (pro Gerät):**
- Max WS-Backoff: **60s** statt 300s → schnellerer Reconnect
- REST-Fallback: **30s Intervall** statt Stopp bei NETWORK-Error → weniger Datenlücken
- Info-Log: "unstable connection detected — using faster reconnect"

**Zurück zu Normal:** Bleibt das Gerät >10 Min stabil verbunden → `recentDisconnects` reset, normaler Modus.
Info-Log: "connection stabilized — using normal reconnect"

**Felder in DeviceConnection:** `lastConnectedAt` (Timestamp), `recentDisconnects` (Zähler)

## WebSocket-Cleanup-Pattern (seit v0.3.1)

`removeAllListeners()` → `ws.on("error", () => {})` → `ws.terminate()` (nicht `ws.close()`).

## Unterstützte Geräte

P1 Meter (HWE-P1), kWh 1-Phase (HWE-KWH1/SDM230), kWh 3-Phase (HWE-KWH3/SDM630), Battery (HWE-BAT).
Energy Socket + Watermeter nur v1 → noch nicht unterstützt.

## Tests (179)

```
test/testClient.ts       → API-Error-Handling (9)
test/testDiscovery.ts    → mDNS (16)
test/testMain.ts         → classifyError, createDeviceConnection (20)
test/testWebSocket.ts    → WebSocket-Flow + envelope validation (19)
test/testStateManager.ts → States + Buttons + boundary hardening (58)
test/package.js          → @iobroker/testing Package-Tests (57)
test/integration.js      → @iobroker/testing Integration-Tests (plain JS)
```

## Versionshistorie

| Version | Datum | Highlights |
|---------|-------|------------|
| 0.6.4 | 2026-04-23 | tsconfig.test.json → outDir `./build-test`, `.catch()`-Wrapper für onReady + onStateChange, `pairingIp` als instanceObject (11-sprachig) statt dynamic in onReady |
| 0.6.3 | 2026-04-18 | API-Boundary-Härtung (WS + REST), Auth-Loop-Stopp bei ungültigem Token, Lazy external-Channel, 29 neue Edge-Case-Tests |
| 0.6.2 | 2026-04-13 | Fix res.on("error"), onUnload try/finally, setObjectNotExistsAsync Hot Path, DRY removeDeviceFromObject |
| 0.6.1 | 2026-04-12 | Code Cleanup: connection-utils Modul, 20 neue Tests, ESLint-Warnings fix, unused Deps entfernt |
| 0.6.0 | 2026-04-11 | Adaptive Unstable-Mode: Auto-Erkennung schlechtes WiFi, schnellerer Reconnect (60s), persistenter REST-Fallback |
| 0.5.1 | 2026-04-08 | Review-Fixes: Standard-Tests (plain JS), CHANGELOG.md entfernt, FORBIDDEN_CHARS-Ref |
| 0.5.0 | 2026-04-05 | Robuster Reconnect: nie aufgeben, periodische mDNS-Retry, nur WS steuert Online |
| 0.4.2 | 2026-04-05 | Konsistente Donation-Labels über alle Adapter |
| 0.4.1 | 2026-04-05 | Fix: measurement/ Channel + cleanupMovedStates (0.4.0 hatte nur statusStates) |
| 0.4.0 | 2026-04-05 | statusStates Online-Icon für Geräte im Objektbaum |
| 0.3.5 | 2026-04-05 | Fix Log-Spam: classifyError + Dedup nach Kategorie, REST stoppt bei NETWORK |
| 0.3.4 | 2026-04-05 | mDNS nur bei Pairing, IP-Recovery, Offline-Erkennung |
| 0.3.0 | 2026-04-05 | Device-Config in Objekten, Reconnect-Workflow, Button-Fixes |
| 0.1.x | 2026-04-04 | Initial: API v2, WebSocket, mDNS, TLS, 129 Tests |

## Befehle

```bash
npm run build        # Production (esbuild)
npm run build:test   # Test build (tsc)
npm test             # Build + mocha
npm run lint         # ESLint + Prettier
```
