# CLAUDE.md — ioBroker.homewizard

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker HomeWizard Adapter** — Echtzeit-Energiedaten via API v2 mit WebSocket-Push (~1/s).

- **Version + Changelog:** current version in `io-package.json`; full internal dev history moved to `.claude/dev-history.md` (local, not auto-loaded). User-facing changelog: `README.md` + `io-package.json` news.
- **GitHub:** https://github.com/krobipd/ioBroker.homewizard
- **npm:** https://www.npmjs.com/package/iobroker.homewizard
- **Repository PR:** ioBroker/ioBroker.repositories#5749
- **Runtime-Deps:** `@iobroker/adapter-core`, `ws`, `bonjour-service`
- **Test-Setup:** Tests unter `src/**/*.test.ts` via **vitest** (seit v0.8.0; vorher mocha+ts-node). `test/package.js` + `test/integration.js` bleiben mocha (`@iobroker/testing` ist mocha-only). Konfiguration `vitest.config.mts` (ESM-Endung, im ESLint-`allowDefaultProject`). Admin-Untergrenze `>=8.0.11` — die Version, gegen die die CI die Einstellungsseite prüft
- **`@types/node` + `@tsconfig/nodeXX` an `engines.node`-Min gekoppelt:** `^22.x` / `@tsconfig/node22` weil `engines.node: ">=22"`. Dependabot ignoriert Major-Bumps

## API v2 Referenz

**Offizielle Doku:** https://api-documentation.homewizard.com/docs/category/api-v2

- HTTPS (self-signed) + WSS, Auth via Bearer Token
- Header: `X-Api-Version: 2`
- Pairing: `POST /api/user` → 403 bis physischer Button gedrückt → 200 + Token
- WebSocket: `wss://<IP>/api/ws` → auth → subscribe `measurement` → Push ~1/s
- Endpoints: `/api` (info), `/api/user` (POST pair / DELETE revoke), `/api/measurement`, `/api/system`, `/api/batteries`, `/api/ws`
- WS topics subscribed nach `authorized`: `measurement` (~1/s) + `system` + `batteries` (explizit, nicht `*`). system/batteries pushen nur bei Control-State-Änderung → REST-Poll bleibt für uptime/rssi-Frische
- Battery-Modi: `zero` / `to_full` / `standby` / `predictive` + `charge_to_full` (boolean, one-shot). Whitelist ist nur User-Frühwarnung — das Gerät lehnt unbekannte Modi selbst per `ERR` ab

## Architektur

```
src/main.ts                  → Adapter (Lifecycle, Pairing, Multi-Device, State-Routing, mDNS-IP-Recovery)
src/lib/connection-manager.ts → ConnectionManager: Reconnect/WS-Push/REST-Fallback/System-Poll/Auth-Stop-State-Machine + Connection-Registry (F5, aus main extrahiert; ConnectionManagerHost-Schnittstelle)
src/lib/types.ts             → Interfaces
src/lib/connection-utils.ts  → classifyError, isAuthError, createDeviceConnection (pure, testbar)
src/lib/main-helpers.ts      → reine Entscheidungs-Helfer (Backoff, Unstable-Hysterese, Cooldown, State-ID-Lookup)
src/lib/cacert.ts            → HomeWizard CA-Cert, shared HTTPS Agent, per-Device-Agents + `pinnedAgent` (welche Identitätsprüfung eine Verbindung bekommt)
src/lib/coerce.ts            → Type-Guards für API-Boundary (coerceFiniteNumber/-String/-Boolean, isPlainObject)
src/lib/discovery.ts         → mDNS (_homewizard._tcp), nur bei Pairing/IP-Recovery
src/lib/homewizard-client.ts → HTTPS-Client (REST)
src/lib/websocket-client.ts  → WSS-Client (Echtzeit)
src/lib/state-manager.ts     → State CRUD + Cleanup, MEASUREMENT_STATE_DEFS mit nameKey/descKey
src/lib/i18n.ts              → Type-safe wrappers for adapter-core I18n (tName/resolveLabel, I18nKey from en.json)
```

## Design-Entscheidungen

1. **Multi-Device Single-Instance** (wie hueemu)
2. **Hue-Style Pairing** — mDNS Discovery → User drückt physischen Knopf → Token
3. **WebSocket primär** — Push ~1/s, REST-Fallback (10s poll bei WS-Disconnect, stoppt bei NETWORK-Error)
4. **bonjour-service** für mDNS (`_homewizard._tcp` v2), nur bei Pairing und IP-Recovery
5. **API v2 only — v1 wird NIEMALS unterstützt.** v1 ist deprecated (kein TLS, kein Token, kein WebSocket). Geräte ohne v2-Support liegen außerhalb des Adapter-Scope. Diese Entscheidung ist final, nicht „noch nicht" und nicht „warten auf v2-Firmware".
6. **Device-Config in Device-Objekten** (seit v0.3.0) — Token mit `this.encrypt()`, KEIN adapter native → kein Restart bei Pairing/Remove
7. **TLS mit CA-Cert + per-Device-CN-Pinning** (CN-Pinning seit v0.13.0) — HomeWizard CA gebündelt (`HW_AGENT`), `minVersion:TLSv1.2`. Etablierte Geräte nutzen einen per-Device-Agent (`createDeviceAgent(certCn)`), dessen `checkServerIdentity` die präsentierte Cert-CN (`appliance/<type>/<serial>`, beim Pairing via `getPeerCertificate()` erfasst + in `native.certCn` persistiert; lazy-Migration beim ersten Connect für Bestandsgeräte) gegen die bekannte Identität prüft. Blanket-Accept (`HW_AGENT`, CN übersprungen) NUR während Pairing (Identität pre-Pairing unbekannt). Schließt LAN-MITM mit fremdem HW-CA-Cert → Token-Harvest. Per offizieller v2-Doku (Hostname-Validierung).
8. **Admin UI ohne Gerätetabelle** — Geräte im Objekte-Tab, nicht in Config
9. **statusStates** (seit v0.4.0) — Device-Objekte haben `statusStates.onlineId` → grün/grau Icon im Objektbaum.
   **Seit v0.18.0 sagt der Marker „das GERÄT antwortet", nicht „der WebSocket steht"** — s. Entscheidung 20.
   **Die Marker-Kette (seit v0.16.0)** — `info.connected` wird an JEDEM Punkt geschrieben, an dem sich das Bild
   ändern kann, nicht nur beim WS-Ereignis: Start-Stempel vor dem ersten Verbindungsversuch (der Wert des
   Vorlaufs überlebt Absturz/Stromausfall), beim Neu-Koppeln eines bekannten Geräts (der Abbau der alten
   Verbindung unterdrückt absichtlich deren Trenn-Handler), beim WS-Verbinden/Trennen und beim Beenden.
   ⚠️ Kein `supportedMessages.stopInstance` im Manifest — mit dem Eintrag lief `onUnload` nie, und der
   Host-seitige Reset von `info.connection` ist selbst defekt (js-controller#3472), der Adapter ist also der
   einzige Schreiber. Einmal-Korrektur `clearStopInstanceFlag()` beim Start, weil der Eintrag als Kopie im
   Instanzobjekt weiterlebt. Mechanik: Memory `reference_stopinstance_verhindert_onunload`.
10. **measurement/ Channel** (seit v0.4.0) — Messdaten unter `measurement/`, nicht lose im Device-Root. `cleanupMovedStates()` räumt alte Pfade auf
11. **WS-Echtzeit für system/batteries additiv, nicht ersetzend** (seit v0.10.0) — WS pusht system/batteries nur bei Control-State-Änderung (uptime/rssi pushen NICHT laufend), darum bleibt der 60s-REST-System-Poll erhalten. `setStateChangedAsync` für langsame Felder verhindert die REST/WS-Doppel-Writes der überlappenden Felder
12. **Token-Revoke beim Entfernen** (seit v0.10.0) — `removeDevice` ruft best-effort `DELETE /api/user` (`{name:"local/iobroker"}`) bevor das Device-Object gelöscht wird, damit auf dem Gerät keine toten `local/iobroker`-User-Tokens bei jedem Pair/Unpair zurückbleiben
13. **Summen-Datenpunkte** (seit v0.16.0) — `info.devicesTotal`/`devicesOnline`/`devicesAllOnline`, abgeleitet
   in `updateGlobalConnection()`, also in derselben Runde und aus derselben Quelle wie `info.connection` und
   die Einzelmarker; eine zweite Rechenstelle würde driften. `devicesTotal` überlebt das Beenden (wie viele
   Geräte eingerichtet sind, ändert sich nicht), `devicesAllOnline` braucht `total > 0` — sonst meldet eine
   frische Installation ohne Gerät Vollzähligkeit. Flotten-Form: Memory `reference_summen_datenpunkte_flotte`.
14. **`onUnload` kommt auch ohne State-Manager durch** (seit v0.17.0) — der State-Manager entsteht erst NACH der
   stopInstance-Korrektur in `onReady`; der von der Korrektur erzwungene Neustart beendet einen Prozess, der nie
   einen gebaut hat. Der Abbau prüft das Feld, schreibt `info.connection` immer und die Geräte-Marker nur, wenn
   es sie geben kann. Vorher warf der Abbau, und selbst `info.connection` blieb ungeschrieben.
15. **WS-Fehler-Entdopplung gilt pro Verbindung** (seit v0.17.0) — `connect()` setzt `lastErrorDetail` zurück.
   Ein Gerät, das nach dem Neuverbinden denselben Fehler-Frame schickt, wird wieder gewarnt; vorher schwieg der
   Adapter für den Rest seiner Laufzeit, weil der Vergleichswert den Reconnect überlebte.
16. **Ack trägt den gesendeten Wert, nicht den Rohwert** (seit v0.17.0) — `cloud_enabled`, `api_v1_enabled`,
   `charge_to_full` werden mit `!!state.val` ans Gerät geschickt und mit genau diesem Boolean bestätigt. Ein
   Skript, das `"true"` oder `1` schreibt, bekam vorher den String/die Zahl als Ack in den Boolean-Datenpunkt.
17. **Jeder Geräte-String, der Objektname wird, läuft durch `sanitizeForLog`** — seit v0.14.0 der Produktname (L9),
   seit v0.17.0 auch der `type` eines externen Zählers (`external.<type>_<id>`-Kanal). Objekt-IDs säubert
   `sanitize()` separat; Namen brauchen den CR/LF-Strip, weil sie ungeprüft in den Objektbaum gehen.
18. **`errText` liefert IMMER einen String** (seit v0.17.0, Flotten-Defekt) — `JSON.stringify` gibt für Symbol,
   Funktion und `toJSON → undefined` `undefined` zurück, ohne zu werfen; der `catch` lief also nie und die Funktion
   log trotz `string`-Signatur. Symbol → `String(sym)`, sonst `?? Object.prototype.toString.call(err)`.
19. **`HomeWizardApiError.errorCode` ist String oder `"unknown"`** (seit v0.17.0) — Geräte-Form
   `{error:{code,description}}` und flaches `{error:"…"}` werden gelesen; alles, was kein String ist (Zahl,
   Objekt, `{error:{}}`), bleibt `"unknown"`, die Beschreibung fällt dann auf den Rohkörper zurück. Vorher konnte
   ein Objekt im String-Feld landen und als `[object Object]` im Log stehen.
20. **Die Verbindungs-Anzeigen beschreiben das GERÄT, nicht einen Transportweg** (seit v0.18.0, ersetzt
    die alte Entscheidung 8). Der Rollen-Katalog definiert `indicator.reachable` als „if a device is
    online" — ein Gerät, das den REST-Rückfall beantwortet, IST online, auch wenn der WebSocket gerade
    nicht steht. `isDeviceOnline(conn) = wsAuthenticated || restHealthy` ist die EINZIGE Quelle für den
    Geräte-Marker, die `info.devices*`-Summe UND den System-Poll-Filter; eine zweite Rechenstelle würde
    driften (wie Entscheidung 13). `restHealthy` wird nach einem erfolgreichen Rückfall-Abruf gesetzt,
    bei dessen erstem Fehlschlag gelöscht und beim WS-Verbinden/-Trennen sowie im Abbau zurückgesetzt —
    der Wert verfällt also von selbst. Vorher meldeten beide Anzeigen bis zu fünf Minuten „nicht
    verbunden", während Messwerte in den Baum liefen; am sichtbarsten bei Geräten mit schwachem Empfang,
    für die der Rückfall überhaupt gebaut wurde. `info.connected` wird nirgends gelesen, nur geschrieben
    — Reconnect, IP-Wiederfindung und Unstable-Erkennung hängen weiter an `wsAuthenticated`.
21. **Ein Update erreicht die Namen BESTEHENDER Anlagen** (seit v0.18.0). Vier Schichten, die vorher
    alle einfroren: die sieben Manifest-Objekte bekommen in `onReady` je einen ausgeschriebenen
    `extendObject`-Aufruf (`ensureManifestObjects`, wörtlich statt Schleife — sonst hat das
    Konsistenz-Gate nichts zu prüfen); `createState`, der `info`-Kanal, `ensureChannel` und
    `createButton` schreiben ohne `preserve` bzw. mit `extendObject` statt `setObjectNotExists`.
    **`preserve: {common:["name"]}` bleibt an genau zwei Stellen** — dem Geräte-Objekt (Name kommt vom
    Gerät, der Nutzer darf ihn ändern) und dem Kanal eines externen Zählers (`deviceOwnedName: true`).
    Ein Test hält die Liste der `preserve`-Stellen fest; kein Gate sieht diesen Fehler sonst.
22. **`supportedMessages` wird GELÖSCHT, nicht auf `false` gesetzt** (seit v0.18.0). Die Liste ist eine
    POSITIVliste: ein `{stopInstance:false}` — und selbst ein leeres Objekt — heißt „nur diese
    Nachrichten werden unterstützt", also keine. Die Messagebox stirbt dann still, kein `sendTo`
    kommt an, nichts wird protokolliert. Auslöser der Einmal-Korrektur ist deshalb die bloße Existenz
    des Schlüssels, der Schreibvorgang ist `{ common: { supportedMessages: null } }`.
23. **Adressen aus mDNS werden strenger geprüft als eine eingetippte** (seit v0.18.0). `isLanDeviceIpv4`
    (nur 10/8, 172.16/12, 192.168/16) gilt für den mDNS-Weg: dort tippt niemand, und ein echtes Gerät
    kann link-lokal keine öffentliche Adresse ansagen — ein bösartiger Responder aber schon. Der manuelle
    Pairing-Pfad behält `isAssignableDeviceIpv4` (sperrt Loopback/Link-Local/0.x/Broadcast, lässt
    öffentliche Adressen zu), weil ein Heimnetz auf öffentlichem Bereich selten, aber real ist.
    CGNAT (100.64/10) gehört NICHT dazu — das liegt auf der WAN-Seite des Routers.
24. **Ein Gerät ohne gespeicherte IP meldet sich** (seit v0.18.0) — Warnung beim Start plus einmaliger
    Anstoß der mDNS-Wiederfindung. Vorher bekam es keinen Verbindungsversuch, und die Wiederfindung wird
    ausschließlich aus `connectWebSocket` angestoßen, wohin ein Gerät ohne IP nie gelangt: es blieb bis
    zum nächsten Neustart oder Neu-Koppeln stumm liegen.
25. **Ein Knopf fällt auch nach einem Fehlschlag zurück** (seit v0.18.0) — `finally` um **genau den
    einen** Geräteaufruf, nie um den ganzen Handler: dort würde es den LED-Prozentwert und jede
    Schalter-Bestätigung mit `false` überschreiben. Die Rückstellung selbst schluckt ihren Fehler,
    damit sie den ursprünglichen nicht verdrängt.
26. **Batterie-Datenpunkte überleben die Batterie nicht** (seit v0.18.0) — meldet der System-Poll
    zweimal hintereinander `battery_count: 0`, wird der `battery`-Zweig entfernt statt mit den letzten
    Werten zu altern. Ausgewertet wird am 60-s-Poll, nicht am 1-Hz-Push: ein einzelner Aussetzer würde
    sonst den Objektbaum durchwalken und die Historie zerschneiden.

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
8. **Im LAUFENDEN Betrieb steuert nur der WebSocket `info.connected`** — der REST-Rückfall liefert Daten, flippt aber nicht den Online-Status. Außerhalb des Betriebs schreiben ihn drei weitere Stellen (Start-Stempel, Neu-Koppeln, Beenden) — s. Design-Entscheidung 9, die Marker-Kette.

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

## Tests (453 unit + 57 package = 510)

## Multi-Language (seit v0.7.0)

Variant A wie hassemu — Single-Instance, Multi-Device, daher reicht ein global gelesener `systemLang`.

- `lib/i18n.ts` — Type-safe wrapper with `I18nKey` derived from `admin/i18n/en.json`. `tName(key)` returns `I18n.getTranslatedObject(key)`. Compile-time safety against typos.
- `../scripts/sync-iopackage-from-i18n.py` — hält `io-package.json:instanceObjects` deterministisch synchron mit `admin/i18n` (zentral, single-source-of-truth).
- `main.ts:onReady` liest `system.config.language` einmalig in `this.systemLang`. Sprachwechsel im Admin braucht Adapter-Restart — akzeptabel (User wechselt nicht regelmäßig).

## Befehle

```bash
npm run build        # Production (esbuild via @iobroker/adapter-dev)
npm run check        # tsc --noEmit type-check
npm test             # vitest run + mocha package tests
npm run coverage     # vitest --coverage
npm run lint         # ESLint + Prettier
```
