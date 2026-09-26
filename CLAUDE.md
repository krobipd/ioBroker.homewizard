# CLAUDE.md — ioBroker.homewizard

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker HomeWizard Adapter** — Echtzeit-Energiedaten via API v2 mit WebSocket-Push (~1/s).

- **Version + Changelog:** current version in `io-package.json`; full internal dev history moved to `.claude/dev-history.md` (local, not auto-loaded). User-facing changelog: `README.md` + `io-package.json` news.
- **GitHub:** https://github.com/krobipd/ioBroker.homewizard
- **npm:** https://www.npmjs.com/package/iobroker.homewizard
- **Repository PR:** ioBroker/ioBroker.repositories#5749
- **Runtime-Deps:** `@iobroker/adapter-core`, `ws`, `bonjour-service`
- **Test-Setup:** Tests unter `src/**/*.test.ts` via **vitest** (seit v0.8.0; vorher mocha+ts-node). `test/package.js` + `test/integration.js` bleiben mocha (`@iobroker/testing` ist mocha-only). Konfiguration `vitest.config.mts` (ESM-Endung, im ESLint-`allowDefaultProject`). `tsconfig.json` deckt seit 2026-09-08 auch `test/**` (Typprüfung der Testdateien, Flotten-Master) — `test/standards` steht deshalb NICHT in `allowDefaultProject`, typescript-eslint verweigert eine Datei in beidem. Admin-Untergrenze `>=8.0.11` — die Version, gegen die die CI die Einstellungsseite prüft
- **`@types/node` + `@tsconfig/nodeXX` an `engines.node`-Min gekoppelt:** `^22.x` / `@tsconfig/node22` weil `engines.node: ">=22"`. Dependabot ignoriert Major-Bumps

## API v2 Referenz

**Offizielle Doku:** https://api-documentation.homewizard.com/docs/category/api-v2

- HTTPS (self-signed) + WSS, Auth via Bearer Token
- Header: `X-Api-Version: 2`
- Pairing: `POST /api/user` → 403 bis physischer Button gedrückt → 200 + Token
- WebSocket: `wss://<IP>/api/ws` → auth → subscribe `measurement` → Push ~1/s
- Endpoints: `/api` (info), `/api/user` (POST pair / DELETE revoke), `/api/measurement`, `/api/system`, `/api/batteries`, `/api/ws`
- WS topics subscribed nach `authorized`: `measurement` (~1/s) + `system` + `batteries` (explizit, nicht `*`; `batteries` nicht am HWE-BAT, DD42). system/batteries pushen nur bei Control-State-Änderung → REST-Poll bleibt für uptime/rssi-Frische
- Battery-Modi: `zero` (Netto-Null: lädt ODER entlädt) / `to_full` / `standby` (beide laut Doku legacy) / `predictive` + `charge_to_full` (boolean, one-shot). `target_power_w` positiv = laden. Whitelist ist nur User-Frühwarnung — das Gerät lehnt unbekannte Modi selbst per `ERR` ab

## Architektur

```
src/main.ts                  → Adapter (Lifecycle, Multi-Device, State-Routing, mDNS-IP-Recovery, Geräte-Persistenz)
src/lib/connection-manager.ts → ConnectionManager: Reconnect/WS-Push/REST-Fallback/System-Poll/Auth-Stop-State-Machine + Connection-Registry (F5, aus main extrahiert; ConnectionManagerHost-Schnittstelle)
src/lib/pairing-manager.ts   → PairingManager: das Kopplungs-Fenster (60-s-Timer, Fundliste, 2-s-Token-Poll) — aus main extrahiert; main behält den EINEN mDNS-Browser (IP-Recovery teilt ihn) und reicht ihn über PairingManagerHost durch
src/lib/state-defs.ts        → die Deklarations-Tabellen (MEASUREMENT_STATE_DEFS, MOMENTARY_KEYS, DEVICE_LABELLED_OBJECTS, SYSTEM_INFO_FIELDS, EXTERNAL_METER_TYPE_NAMES …) — Daten, kein Verhalten
src/lib/types.ts             → Interfaces
src/lib/connection-utils.ts  → classifyError, isAuthError, createDeviceConnection (pure, testbar)
src/lib/main-helpers.ts      → reine Entscheidungs-Helfer (Backoff, Unstable-Hysterese, Cooldown, State-ID-Lookup)
src/lib/cacert.ts            → HomeWizard CA-Cert, shared HTTPS Agent, per-Device-Agents + `pinnedAgent` (welche Identitätsprüfung eine Verbindung bekommt)
src/lib/coerce.ts            → Type-Guards für API-Boundary (coerceFiniteNumber/-String/-Boolean, isPlainObject)
src/lib/discovery.ts         → mDNS (_homewizard._tcp), nur bei Pairing/IP-Recovery
src/lib/homewizard-client.ts → HTTPS-Client (REST)
src/lib/websocket-client.ts  → WSS-Client (Echtzeit)
src/lib/state-manager.ts     → State CRUD + Cleanup (liest die Tabellen aus state-defs.ts; nameKey/descKey)
src/lib/device-icons.ts      → Piktogramm je Gerätetyp (Inline-SVG aus admin/icons/, DD39)
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
9. **statusStates** — (seit v0.4.0) — `statusStates.onlineId` am Geräte-Objekt; seit v0.16.0 wird `info.connected` an sechs Stellen geschrieben (Start-Stempel, Neu-Koppeln, WS-Verbinden, WS-Trennen, Entfernen, Beenden), kein `supportedMessages.stopInstance` im Manifest.
10. **measurement/ Channel** (seit v0.4.0) — Messdaten unter `measurement/`, nicht lose im Device-Root. `cleanupMovedStates()` räumt alte Pfade auf
11. **WS-Echtzeit für system/batteries additiv, nicht ersetzend** — (seit v0.10.0) — WS pusht system/batteries nur bei Änderung eines Steuerwerts, deshalb bleibt der 60-s-REST-System-Poll für uptime/rssi.
12. **Token-Revoke beim Entfernen** — (seit v0.10.0) — `removeDevice` ruft best-effort `DELETE /api/user` mit dem gespeicherten Nutzernamen (DD43; Altgerät ohne Feld: `local/iobroker`), bevor das Geräte-Objekt gelöscht wird.
13. **Summen-Datenpunkte** — (seit v0.16.0) — `info.devicesTotal`/`devicesOnline`/`devicesAllOnline` entstehen in `updateGlobalConnection()` aus derselben Quelle wie `info.connection`; `devicesTotal` überlebt das Beenden, `devicesAllOnline` braucht `total > 0`.
14. **`onUnload` kommt auch ohne State-Manager durch** — (seit v0.17.0) — der Abbau prüft, ob es den State-Manager gibt, schreibt `info.connection` immer und die Geräte-Marker nur, wenn es sie geben kann.
15. **WS-Fehler-Entdopplung gilt pro Verbindung** — (seit v0.17.0) — `connect()` setzt `lastErrorDetail` zurück.
16. **Ack trägt den gesendeten Wert, nicht den Rohwert** — (seit v0.17.0) — Schalter werden über `coerceSwitch` gelesen und mit genau dem gesendeten Boolean bestätigt; ein Wert, der weder an noch aus ist, wird gewarnt und nicht gesendet; Knöpfe lösen nur bei `true` aus.
17. **Jeder Geräte-String, der Objektname wird, läuft durch `sanitizeForLog`** — seit v0.14.0 der Produktname (L9), seit v0.17.0 auch der `type` eines externen Zählers (`external.<type>_<id>`-Kanal).
18. **`errText` liefert IMMER einen String** — (seit v0.17.0, Flotten-Defekt) — Symbol → `String(sym)`, sonst `?? Object.prototype.toString.call(err)`; nie `undefined` aus `JSON.stringify`.
19. **`HomeWizardApiError.errorCode` ist String oder `"unknown"`** — (seit v0.17.0) — gelesen werden `{error:{code,description}}` und flaches `{error:"…"}`; alles, was kein String ist, bleibt `"unknown"`, die Beschreibung fällt dann auf den Rohkörper zurück.
20. **Die Verbindungs-Anzeigen beschreiben das GERÄT, nicht einen Transportweg** — (seit v0.18.0, ersetzt die alte Entscheidung 8) — `isDeviceOnline(conn) = wsAuthenticated || restHealthy` ist die EINZIGE Quelle für Geräte-Marker, `info.devices*` und den System-Poll-Filter; Reconnect, IP-Wiederfindung und Unstable-Erkennung hängen weiter an `wsAuthenticated`.
21. **Ein Update erreicht die Namen BESTEHENDER Anlagen** — (seit v0.18.0) — die sieben Manifest-Objekte bekommen in `onReady` je einen ausgeschriebenen `extendObject`-Aufruf (`ensureManifestObjects`); kein Schreibvorgang trägt `preserve` (seit v0.19.0), die zwei gerätegegebenen Namen werden aus dem aktuellen Gerätewert geschrieben; `product_name` ist fest, nie der App-Name.
22. **`supportedMessages` wird GELÖSCHT, nicht auf `false` gesetzt** — (seit v0.18.0) — Auslöser der Einmal-Korrektur ist die bloße Existenz des Schlüssels, geschrieben wird `{ common: { supportedMessages: null } }` (die Liste ist eine Positivliste).
23. **Adressen aus mDNS werden strenger geprüft als eine eingetippte** — (seit v0.18.0) — der mDNS-Weg nimmt nur `isLanDeviceIpv4` (10/8, 172.16/12, 192.168/16), der manuelle Pairing-Pfad `isAssignableDeviceIpv4`; CGNAT 100.64/10 gehört nicht dazu.
24. **Ein Gerät ohne gespeicherte IP meldet sich** — (seit v0.18.0) — Warnung beim Start plus einmaliger Anstoß der mDNS-Wiederfindung.
25. **Ein Knopf fällt auch nach einem Fehlschlag zurück** — (seit v0.18.0) — `finally` um genau den einen Geräteaufruf, nie um den ganzen Handler; die Rückstellung schluckt ihren eigenen Fehler.
26. **Batterie-Datenpunkte überleben die Batterie nicht** — (seit v0.18.0) — zweimal hintereinander `battery_count: 0` am 60-s-Poll entfernt den `battery`-Zweig (nicht am 1-Hz-Push).
27. **Die Namen werden bei JEDEM Start aufgefrischt — ohne Merker** — (seit v0.18.1) — `refreshExistingNames()` überschreibt das Namensfeld vorhandener Objekte aus der Start-Objektliste, legt nichts an; `removeRetiredMarkers()` räumt `info.legacyMigrated`/`info.labelsVersion` ab.
28. **Ein Gerät, das der Adapter nicht laden konnte, bleibt entfernbar** — (seit v0.18.2) — `removeUnloadedDevice` leitet den Präfix aus der Knopf-ID ab, prüft das `device`-Objekt und löscht über `removeDeviceByPrefix`; die Logzeile sagt, dass der Token nicht widerrufen werden konnte.
29. **Name und Firmware folgen dem Gerät im laufenden Betrieb** — (seit v0.18.2) — `syncDeviceInfo` (Erstverbindung + jeder zehnte System-Poll) führt `info.firmware` nach und den Namen nur, wenn die Firmware einen anderen `product_name` meldet; `firmware_version` ist optional.
30. **`onStateChange` ist eine Tabelle, und der Knopf-Rückfall ist strukturell** — (seit v0.18.2) — `deviceCommands`: ein Eintrag ist entweder ein Knopf (wird immer auf `false` zurückgestellt) oder ein Wert-Datenpunkt (bestätigt den gesendeten Wert), nie beides.
31. **Der Label-Nachzug überspringt, was dieser Start schon geschrieben hat** — (seit v0.18.2) — `refreshExistingNames` überspringt `createdIds`; ein Test für den Nachzug braucht deshalb einen NEUEN Prozess/`StateManager`.
32. **Die `common.states`-Reparatur räumt einen übrig gebliebenen SCHLÜSSEL weg** — (Begründung korrigiert v0.18.2) — der Objektspeicher merged tief (`node.extend(true, …)`) und entfernt keinen Schlüssel; nur dafür schreibt die Reparatur vollständig per `setObjectAsync`.
33. **Der Kanalname eines externen Zählers ist übersetzt** — (seit v0.18.2) — der `type` kommt aus einer geschlossenen API-Liste und wird übersetzt; nur ein Typ außerhalb der Liste wird mit dem Rohwert (CR/LF-Strip) benannt, ohne `preserve`.
34. **Jeder Datenpunkt hat eine Beschreibung oder einen begründeten Verzicht** — (seit v0.18.2) — die Entscheidung steht in `test/self-explaining.json` und wird von Gate D08 gegen `test/objects.inventory.json` geprüft; D08 prüft „entschieden“, nicht „gut“.
35. **Die IP-Wiederfindung kennt KEINEN In-Flight-Guard** — (seit v0.19.0) — kein `recovering`-Feld: die mDNS-Antwort kommt je Browser-Lauf nur einmal und fiel in das Fenster des hängenden Sockets; seit v0.20.0 teilen Wiederfindung und Kopplung EINEN Browser, eine neue Anfrage startet ihn neu.
36. **Die Agenten eines entfernten Geräts fallen ERST nach dem Widerruf** — (seit v0.19.0) — `dropDeviceAgent` läuft im `.finally` des Widerrufs und entfällt, wenn unter demselben Schlüssel wieder ein Gerät steht; ein Fehlschlag ist `info`.
37. **Ein 404 auf `/api/batteries` ist eine andere Aussage als `battery_count: 0`** — (seit v0.19.0) — ein 404 auf `/api/batteries` räumt einen `battery`-Zweig SOFORT (einmal je Verbindung, `batteryUnsupported`); die Route lebt am P1/kWh, nicht am HWE-BAT.
38. **Der Label-Nachzug darf nicht wiederbeleben, was derselbe Start gelöscht hat** — (seit v0.19.0) — `StateManager.removedIds` merkt sich die in diesem Lauf gelöschten Zweige, `refreshExistingNames` überspringt sie (`extendObject` auf ein fehlendes Objekt legt es an).
39. **Jedes Gerät trägt ein Piktogramm seines Typs** — (seit v0.19.0) — `common.icon` als Inline-`data:image/svg+xml` der Dateibytes aus `admin/icons/` (`device-icons.ts`), bei jedem Start gesetzt, Zeilenenden normalisiert, unbekannter Typ lässt das Feld unangetastet.
40. **`tier` erreicht nur NEUE Instanzen** — (gemessen 2026-09-15, `setupUpload.ts:734-743`) — `tier` steht in `preserveAttributes`; der Adapter schreibt ihn NIE an Bestandsinstanzen nach.
41. **Ein externer Zähler, der einen Tag lang UND in 100 empfangenen Messungen mit `external`-Feld fehlt, wird entfernt** (seit v0.20.0) — Bestandskanäle werden beim Start aus dem Baum eingesetzt (`seedExternalMeters`).
42. **Jedes Gerät bekommt nur die Steuerungen, die sein Typ laut Doku hat** (seit v0.20.0) — kWh-Zähler ohne Identify und ohne LED-Helligkeit (alte Objekte werden gelöscht UND in `removedIds` vermerkt, sonst belebt der Label-Nachzug sie wieder — DD38), Plug-In Battery ohne Reboot, ohne `/api/batteries`-Abfrage und ohne `batteries`-Thema (`supportsIdentify`, `supportsStatusLed`, `servesBatteryGroup`).
43. **Jede Instanz koppelt unter eigenem Nutzernamen `local/iobroker_<host>_<instance>`** (seit v0.20.0) — gespeichert in `native.userName`; beim Neu-Koppeln wird ein abweichender alter Nutzer mit SEINEM alten Token gelöscht, nie mit dem neuen.
44. **Ein Kopplungs-Token wird nur widerrufen, solange das Gerät nicht gespeichert ist** (seit v0.20.0) — danach verzögert ein Fehler nur die Datenpunkte; ein Durchlauf endet nach jedem `await`, wenn das Fenster zu ist, und das Fenster schließt mit seinem Ergebnis auf info.
45. **Ein Gerät, das nicht antwortet (NETWORK, TIMEOUT), loggt auf debug; nur ein gewarnter Fehler bekommt „connection restored“** (seit v0.20.0) — Flottenregel „offline ist ein Zustand“ (2026-09-22), ersetzt das warn-einmal-Muster aus v0.7.3.

_Beleg, Messung und Verlauf jeder Nummer wörtlich in `.claude/dev-history.md` — 1–40 im Eintrag „2026-09-27 — Design-Entscheidungen 1–40: Belege aus CLAUDE.md verlegt“, 41–45 im Eintrag „2026-09-24 — v0.20.0: Belege zu DD41–45“._

## Error-Handling (seit v0.3.5)

Folgt beszel/parcelapp Pattern:

- **`classifyError()`** → Kategorien: NETWORK, TIMEOUT, AUTH, IDENTITY (fehlgeschlagener Zertifikats-Pin `HW_CERT_IDENTITY` oder TLS-Kettencode — ein anderes Gerät an der Adresse), HTTP_xxx, UNKNOWN
- **Dedup per Device:** `lastErrorCode` = Kategorie (NICHT `${context}:${code}`)
- **NETWORK/TIMEOUT** = debug (DD45); **andere Kategorie, erster Fehler** = warn (Cooldown 1 h je Gerät), **Wiederholung** = debug, **Recovery** = info „connection restored“ nur nach einer Warnung
- **REST-Fallback stoppt** bei NETWORK (stabile Geräte) und bei IDENTITY (alle Geräte)
- **System-Poll** für jedes Gerät, das antwortet (WS oder Rückfall, DD20)

## Reconnect-Workflow (seit v0.5.0)

1. WS disconnected → debug (DD45) → REST-Fallback + WS-Reconnect (exponential backoff, max 5 min)
2. REST bekommt NETWORK-Error → REST stoppt (WS-Reconnect läuft weiter)
3. Nach 3 WS-Failures → mDNS IP-Recovery (60s Timeout)
4. mDNS findet neue IP → Update + Reconnect
5. mDNS findet nichts → **WS-Reconnect läuft weiter** (alle 5 min), mDNS-Retry ~stündlich
6. **Adapter gibt NIE auf** — designed für Geräte mit schlechtem WiFi (stundenlange Ausfälle)
7. Auth-Backoff: nach 3 Auth-Failures Stopp (WS UND laufender Rückfall), EINE warn "token invalid — re-pair"; ein Gerät im Auth-Stopp lässt sich per mDNS neu koppeln (DD35)
8. **`info.connected` = WebSocket authentifiziert ODER REST-Rückfall antwortet** (DD20) — ein gescheiterter Neuversuch bei laufendem, antwortendem Rückfall setzt ihn nicht zurück. Außerhalb des Betriebs schreiben ihn drei weitere Stellen (Start-Stempel, Neu-Koppeln, Beenden) — s. Design-Entscheidung 9, die Marker-Kette.

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

## Tests (Zahl live über `npm test`, nicht hier gepinnt) + Objekt-Inventar + Mutationstabellen

`npm run test:inventory` fährt den Adapter in einem Wegwerf-js-controller gegen vier Fixture-Geräte
(P1, kWh 1-phasig, kWh 3-phasig, Battery) und schreibt `test/objects.inventory.json`. Die Geräte
sind lokale TLS-Server, die `test/inventory-hook.cjs` per `NODE_OPTIONS=--require` IM
ADAPTERPROZESS startet; umgelenkt wird an der einen Stelle, durch die HTTPS und WSS beide gehen
(`tls.connect`). Die Zertifikatsprüfung bleibt AN — nur der Vertrauensanker ist die
Wegwerf-CA des Laufs, weil ein lokaler Server kein von HomeWizard signiertes Zertifikat haben kann.
⚠️ Der Lauf BAUT NICHT: `npm run build` gehört davor, sonst misst er einen alten Bau-Ausgang.
Seit 2026-09-15 läuft derselbe Harness in der CI bei jedem Push (Gate-Job `adapter-inventory`); zwei
Runner-Lektionen stecken im Harness: `encryptedToken` je Controller ist Chiffretext des
Installationsgeheimnisses und am Mac anders als auf dem Runner — der Abzug maskiert die Felder aus
`ENCRYPTED_NATIVE` (`<encrypted with the installation secret>`); und der Abzug wartet auf
`battery.max_production_w` plus einen 4×250 ms ruhigen Objektsatz, statt in laufende Batterie-
Schreibvorgänge hineinzulesen (eine feste Pause ist am Mac kalibriert, nicht am Runner).

**Mutationstabellen** (`Ressourcen/iobroker-entwicklung/mutation-testing/mutations_homewizard*.py`,
Liste per `ls`; `_all` und `_regression_*` sind AGGREGAT-Module, die die zwei Basistabellen dynamisch
laden — nie als statische Tabelle überschreiben). Gate D09 prüft trocken, dass jede Nadel noch genau
einmal trifft. ⚠️ **Ein Umbau verwaist Nadeln, ohne dass ein Gate rot wird** — die Regel gilt dann
still als geprüft. Beim v0.18.2-Umbau traf das 23 Nadeln (ausgelagerte Dateien, inline gezogene
Hilfsfunktion, acht `endsWith`-Zweige zur Tabelle verschmolzen). Nachziehen heißt: gleiche Regel,
neue Stelle — **niemals `build_mutations.py` blind neu laufen lassen**, es liest die Nadel
zeilengenau aus der heutigen Quelle und schreibt grüne Nadeln auf falschen Code. `--check` grün
beweist nur, dass die Nadel existiert; dass sie die Regel TRIFFT, beweist erst der echte Lauf.

`plan_homewizard*.py` erzeugen die zwei Basistabellen (`build_mutations.py <plan> <tabelle>`,
Round-Trip stabil). ⚠️ Die Zeilennummer im Plan zeigt auf die letzte Zeile, die sich zwischen Nadel
und Ersatz UNTERSCHEIDET — der Generator ersetzt immer die letzte Nadelzeile, und wo die Änderung
weiter oben sitzt (K17), entsteht sonst ein stiller No-op. Die zwei DATIERTEN Tabellen haben keinen
Plan: ihre zeilen-entfernenden Mutationen kann der Generator nicht ausdrücken, sie sind handgepflegt.

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
npm run test:inventory  # Objekt-Inventar aus Fixtures (build davor!)
```
