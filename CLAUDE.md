# CLAUDE.md — ioBroker.homewizard

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker HomeWizard Adapter** — Echtzeit-Energiedaten via API v2 mit WebSocket-Push (~1/s).

- **Version:** 0.8.0 (released 2026-05-17) — Toolchain-Parity: TypeScript ~6.0.3, vitest statt mocha+chai, eslint-config 2.3.4, release-script 5.2.0. `asName()` no-op entfernt. `sync-iopackage-from-i18n.py` (hassemu/beszel-Linie). extIcon raw→jsdelivr (CSP-Fix). nyc/source-map-support/ts-node raus. `pre-release.py --audit-current` Hook.
- **Vorgänger 0.7.8** (released 2026-05-13) — Debug-Coverage HTTPS-Layer + state-manager step-tracing. `HomeWizardClient` bekommt `HomeWizardClientLogger`-Interface via `options.log`, `request<T>()` emittiert 4 debug-Statements pro Call (entry mit method/path/auth=bearer/none, success mit status/elapsed/bytes, HTTP-fail mit body-snippet ≤200 chars, pre-response-error mit message/elapsed — Token NIE im Log, nur Presence). Wired durch alle 6 instantiation-Sites in main.ts. State-manager: 3 debug-Calls für rare-event-Ops (createDeviceStates / removeDevice mit cache-drop-count / cleanupMovedStates mit removed-count). Hot-Path `updateMeasurement` bewusst silent. Auslöser: krobi-Auftrag nach v0.7.7. v0.8.0 (Govee-Diag-Pattern-Port) rolled back — Pattern-Übertragung A→B braucht Architektur-Match-Prüfung ([[feedback_pattern_nicht_blind_uebertragen]]).
- **Vorgänger 0.7.7** (2026-05-13) — Per-Device 1h-Cooldown gegen chronisches Bouncing-Log-Spam.
- **Vorgänger 0.7.6** (2026-05-12) — Fix Admin React #31 fatal "Error in GUI" beim Öffnen des `battery.mode`-Dropdowns (HWE-BAT, `write:true` → akuter Crash) und beim `tariff`-State (`write:false` → latent). `common.states` VALUES müssen plain-string sein. Neuer `resolveLabel(key, lang)` in `lib/i18n-states.ts` mit EN-Fallback. `tariffStates(lang)`/`batteryModeStates(lang)` nutzen ihn. Plus `repairCommonStatesIfBuggy(id, fresh)`-Helper in StateManager: bei existierenden Datapoints mit i18n-Object-Values (geschrieben von v0.7.0-v0.7.5) wird `common.states` via `setObjectAsync` aktiv ersetzt, weil `setObjectNotExistsAsync` no-op ist und `extendObjectAsync` deep-merge das Object nicht durch string ersetzen kann. +3 Regression-Tests. v0.7.5 (released 2026-05-10, npm latest) 18-Finding Robustness-Audit: WS-Heartbeat (30s ping / 10s pong) gegen halb-tote Verbindungen, 45s Auth-Handshake-Timeout, IP-recovery race-free, 404-battery-silence, IPv4-validation, single-corrupted-token isolation, multi-pairing-window, parallel system polling, productName drift sync.
- **GitHub:** https://github.com/krobipd/ioBroker.homewizard
- **npm:** https://www.npmjs.com/package/iobroker.homewizard
- **Repository PR:** ioBroker/ioBroker.repositories#5749
- **Runtime-Deps:** `@iobroker/adapter-core`, `ws`, `bonjour-service`
- **Test-Setup:** Tests unter `src/**/*.test.ts` via **vitest** (seit v0.8.0; vorher mocha+ts-node). `test/package.js` + `test/integration.js` bleiben mocha (`@iobroker/testing` ist mocha-only)
- **`@types/node` + `@tsconfig/nodeXX` an `engines.node`-Min gekoppelt:** `^22.x` / `@tsconfig/node22` weil `engines.node: ">=22"`. Dependabot ignoriert Major-Bumps

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
src/lib/coerce.ts            → Type-Guards für API-Boundary (coerceFiniteNumber/-String/-Boolean, isPlainObject)
src/lib/discovery.ts         → mDNS (_homewizard._tcp), nur bei Pairing/IP-Recovery
src/lib/homewizard-client.ts → HTTPS-Client (REST)
src/lib/websocket-client.ts  → WSS-Client (Echtzeit)
src/lib/state-manager.ts     → State CRUD + Cleanup, MEASUREMENT_STATE_DEFS mit nameKey/descKey
src/lib/i18n-states.ts       → STATE_NAMES + STATE_DESCS + STATE_LABELS (~109 Keys × 11 Sprachen) + tName/tDesc/tLabel
```

## Design-Entscheidungen

1. **Multi-Device Single-Instance** (wie hueemu)
2. **Hue-Style Pairing** — mDNS Discovery → User drückt physischen Knopf → Token
3. **WebSocket primär** — Push ~1/s, REST-Fallback (10s poll bei WS-Disconnect, stoppt bei NETWORK-Error)
4. **bonjour-service** für mDNS (`_homewizard._tcp` v2), nur bei Pairing und IP-Recovery
5. **API v2 only — v1 wird NIEMALS unterstützt.** v1 ist deprecated (kein TLS, kein Token, kein WebSocket). Geräte ohne v2-Support liegen außerhalb des Adapter-Scope. Diese Entscheidung ist final, nicht „noch nicht" und nicht „warten auf v2-Firmware".
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

**Außerhalb des Scope (final, nicht „noch nicht"):** Energy Socket (HWE-SKT), Watermeter (HWE-WTR), Energy Display (HWE-DSP). Diese Geräte sprechen nur die deprecated v1-API. Adapter ist v2-only — siehe Design-Entscheidung 5.

## Tests (225 unit + 57 package = 282)

```
src/main.test.ts                      → classifyError, createDeviceConnection (22)
src/lib/coerce.test.ts                → coerce-Helpers + errText + validateBatteryMode + parseBatteryPermissions + strict-number (33)
src/lib/discovery.test.ts             → mDNS (16)
src/lib/homewizard-client.test.ts     → HomeWizardApiError + HTTP-stub-server tests for all API methods (23)
src/lib/main-helpers.test.ts          → pure decision helpers (decideUnstableTransition, computeReconnectDelay, shouldStartIpRecovery, ...) (24)
src/lib/state-manager.test.ts         → States + Buttons + boundary hardening + Translation-Objects + cache + dBm (62)
src/lib/websocket-client.test.ts      → WebSocket-Flow + envelope validation (19)
test/package.js                       → @iobroker/testing Package-Tests (57)
test/integration.js                   → @iobroker/testing Integration-Tests (plain JS)
```

## Multi-Language (seit v0.7.0)

Variant A wie hassemu — Single-Instance, Multi-Device, daher reicht ein global gelesener `systemLang`.

- `lib/i18n-states.ts` — STATE_NAMES (~93 Keys), STATE_DESCS (10 Keys, nur für nicht-offensichtliche), STATE_LABELS (7 Keys für `tariff` 1-4 + `battery.mode` zero/to_full/standby) × 11 Sprachen. `tName/tDesc/tLabel` returnen Translation-Objects, ioBroker Admin/vis/Object-Browser localizen automatisch.
- `scripts/sync-iopackage-from-i18n.py` — hält `io-package.json:instanceObjects` deterministisch synchron mit `i18n-states.ts` (single-source-of-truth, hassemu/beszel-Linie).
- `main.ts:onReady` liest `system.config.language` einmalig in `this.systemLang`. Sprachwechsel im Admin braucht Adapter-Restart — akzeptabel (User wechselt nicht regelmäßig).

## Versionshistorie

| Version | Datum | Highlights |
|---------|-------|------------|
| 0.8.0 | 2026-05-17 | Toolchain-Parity: TypeScript ~5.9→~6.0.3, mocha+chai→vitest (225 unit), eslint-config 2.2→2.3.4, release-script 5.2.0. Code-Cleanup: `asName()` no-op wrapper entfernt (10 callsites). `pairingIp` in `i18n-states.ts` (single-source-of-truth). `scripts/sync-iopackage-from-i18n.py` (hassemu/beszel-Linie). `io-package.json` extIcon raw→jsdelivr (CSP-Fix). `pre-release.py --audit-current` Hook. nyc/source-map-support/ts-node aus devDeps raus. |
| 0.7.8 | 2026-05-13 | Debug-Coverage HTTPS-Layer + state-manager step-tracing. `HomeWizardClient` bekommt `options.log`, `request<T>()` emittiert 4 debug-Statements pro Call (entry/success/HTTP-fail mit body-snippet/pre-response-error). Logger wired durch alle 6 instantiation-Sites in main.ts. State-manager 3 debug-Calls für rare-event-Ops (createDeviceStates / removeDevice mit cache-drop-count / cleanupMovedStates mit removed-count). Hot-Path `updateMeasurement` bewusst silent. |
| 0.7.7 | 2026-05-13 | Per-Device 1h-Cooldown gegen chronisches Bouncing-Log-Spam — `lastWarnAt`/`lastInfoAt`-Maps + `shouldEmitAfterCooldown`-Helper in main-helpers. Hysterese unstable/stabilized info → debug. mcm-Linie „more is more" gilt nur für debug/silly. +7 Tests. |
| 0.7.6 | 2026-05-12 | Fix Admin React #31 fatal auf `battery.mode`-Dropdown (HWE-BAT `write:true`, akuter Crash) und `tariff`-State (P1 `write:false`, latent). `common.states` VALUES dürfen kein i18n-Object sein — Admin rendert Werte direkt als React-child. Neuer `resolveLabel(key, lang)` + `repairCommonStatesIfBuggy(id, fresh)`-Helper: bei existierenden Datapoints (v0.7.0-v0.7.5 hatte `tLabel(...) as unknown as string`-Cast geschrieben) `getObjectAsync` → `common.states` ersetzen → `setObjectAsync`, weil `setObjectNotExistsAsync` no-op und `extendObjectAsync` deep-merge das nicht ersetzt. +3 Regression-Tests. Pattern aus hassemu v1.28.4 portiert. |
| 0.7.2 | 2026-05-06 | Internal robustness: coerceFiniteNumber strict via DECIMAL_NUMBER_RE (HEX/Exponential/whitespace rejected). updateMeasurement parallel via Promise.all. lib/main-helpers.ts neu (pure decision helpers, +24 Tests). HomeWizardClient agent+port injectable, HTTP-stub-server-Tests für alle Methoden (+14). 160 → 202 unit-Tests. Keine User-sichtbaren Änderungen. |
| 0.7.1 | 2026-05-06 | Performance-Cache: state-Existenz-Prüfung wird nach erstem Anlegen gecacht (~30 Redis-Lookups/s gespart bei P1 Meter mit 1 Hz Push). WiFi-RSSI Einheit dB → dBm. |
| 0.7.0 | 2026-05-06 | Multi-Language komplett über 11 Sprachen (State-Namen, Beschreibungen, Dropdown-Labels für tariff + battery.mode, info/warn/error-Logs). Power-Quality + Belgian-capacity-tariff bekommen common.desc-Tooltips. errText / handleAuthFailure / validateBatteryMode / parseBatteryPermissions als pure Helpers. Baseline auf Node 22 + ioBroker Admin 7.8.23 + @tsconfig/node22 (May-2026 Plattform-Empfehlung). Erstes v0.7.0-Tag wurde wegen MODULE_NOT_FOUND beim deploy gelöscht und mit Workflow-fix (deploy auf Node 24) neu gesetzt. |
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
npm run build        # Production (esbuild via @iobroker/adapter-dev)
npm run check        # tsc --noEmit type-check
npm test             # vitest run + mocha package tests
npm run coverage     # vitest --coverage
npm run lint         # ESLint + Prettier
```
