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
- WS topics subscribed nach `authorized`: `measurement` (~1/s) + `system` + `batteries` (explizit, nicht `*`). system/batteries pushen nur bei Control-State-Änderung → REST-Poll bleibt für uptime/rssi-Frische
- Battery-Modi: `zero` / `to_full` / `standby` / `predictive` + `charge_to_full` (boolean, one-shot). Whitelist ist nur User-Frühwarnung — das Gerät lehnt unbekannte Modi selbst per `ERR` ab

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

27. **Die Namen werden bei JEDEM Start aufgefrischt — ohne Merker** (seit v0.18.1). v0.18.0 machte die
    Namen erreichbar, aber der Baum einer bestehenden Anlage trug sie trotzdem noch als feste Strings:
    Objekte, die vor der Übersetzungs-Umstellung entstanden sind, werden von `extendObject` nur dann
    berührt, wenn der Adapter sie in dieser Runde überhaupt anfasst. `refreshExistingNames()` läuft
    deshalb über die vorhandene Objektliste und überschreibt das Namensfeld — es legt nichts an und
    braucht keinen Merker im Baum. Ein Versions-Merker wäre sogar schädlich: er entscheidet über die
    Auffrischung, altert still mit und ist ein Datenpunkt, den niemand bestellt hat. `removeRetiredMarkers()`
    räumt die zwei Merker früherer Versuche (`info.legacyMigrated`, `info.labelsVersion`) bei
    Bestandsanlagen ab.

28. **Ein Gerät, das der Adapter nicht laden konnte, bleibt entfernbar** (seit v0.18.2). Ein
    Geräte-Objekt ohne lesbaren Token wird beim Laden übersprungen — es hat damit keine
    Verbindung, und die Entfernung ging bis dahin von genau dieser Verbindung aus: der `remove`-
    Knopf tat wortlos nichts, der Baum blieb liegen, der Knopf blieb gedrückt. `removeUnloadedDevice`
    leitet den Präfix aus der Knopf-ID ab, prüft, dass dort wirklich ein `device`-Objekt steht, und
    löscht über `removeDeviceByPrefix`. Der Token kann dabei NICHT widerrufen werden — ihn zu lesen
    ist ja das, was scheiterte —, und genau das sagt die Logzeile, statt eine saubere Entfernung
    vorzutäuschen. Das Überspringen beim Laden meldet sich seitdem ebenfalls (vorher: nichts).
29. **Name und Firmware folgen dem Gerät im laufenden Betrieb** (seit v0.18.2). `syncDeviceInfo`
    ist die eine Stelle für beide Aufrufer (Erstverbindung + jeder zehnte System-Poll). Vorher
    wurde bei einer Umbenennung nur die gespeicherte Konfiguration fortgeschrieben — der Datenpunkt
    `info.productName` behielt den Namen vom letzten Adapterstart, und weil der sichtbare
    Objektname bewusst dem Nutzer gehört (DD21), war der neue Name NIRGENDS zu sehen.
    `info.firmware` wurde überhaupt nur beim Start geschrieben, obwohl der Poll die Antwort mit der
    Version ohnehin holt: ein Gerät, das sich selbst aktualisiert, zeigte die alte Version bis zum
    nächsten Neustart. `firmware_version` ist dabei optional getypt und wird am Schreibort geprüft —
    ein Gerät, das ein reines Anzeigefeld weglässt, darf darüber nicht seine Verbindung verlieren.
30. **`onStateChange` ist eine Tabelle, und der Knopf-Rückfall ist strukturell** (seit v0.18.2).
    Aus acht `id.endsWith(...)`-Zweigen, die alle dasselbe sagten (prüfen → senden → das GESENDETE
    bestätigen), wurde `deviceCommands`. Ein Eintrag ist entweder ein Knopf (Rückgabe `null`, wird
    danach immer auf `false` zurückgestellt) oder ein Wert-Datenpunkt (bestätigt den gesendeten
    Wert) — beides zugleich ist nicht darstellbar. Damit kann die Rückstellung eine Bestätigung
    nicht mehr überschreiben; DD25 hängt nicht länger daran, dass an jeder Stelle genau der
    richtige Aufruf im `finally` steht. Neu abgedeckt: der Knopf fällt auch dann zurück, wenn das
    Gerät gar nicht erreichbar ist, und `startPairing` bei bereits offenem Fenster.
31. **Der Label-Nachzug überspringt, was dieser Start schon geschrieben hat** (seit v0.18.2).
    `refreshExistingNames` prüft `createdIds`: was `createDeviceStates` oder ein eingehender
    Messwert in dieser Runde bereits angefasst hat, trägt das aktuelle Label per Definition. Auf
    einem P1 sind das rund 40 Objekt-Schreibvorgänge weniger pro Start. ⚠️ Ein Bestand mit alten
    Labels ist deshalb IMMER ein neuer Prozess: ein Test, der ihn im selben `StateManager`
    nachstellt, misst den Cache statt den Nachzug.
32. **Die `common.states`-Reparatur räumt einen übrig gebliebenen SCHLÜSSEL weg** (Begründung
    korrigiert v0.18.2). Gemessen an der einzigen Merge-Stelle des Objektspeichers
    (`node.extend(true, …)` in `objectsInRedisClient._extendObject`): ein einfacher String
    ersetzt sehr wohl einen Objektwert. Was der Merge NICHT kann, ist einen Schlüssel entfernen,
    den die neue Karte nicht mehr führt — und trägt der ein Übersetzungsobjekt, stirbt Admins
    Auswahlliste an React-Fehler #31. Nur dafür ist der vollständige `setObjectAsync` da. Die
    frühere Begründung („extendObject kann ein Objekt nicht durch einen String ersetzen") war nie
    gegen js-controller gemessen, und der Test, der die Reparatur benannte, erreichte sie nie: die
    Prüfvorrichtung merged `common` flach. Sie merged jetzt tief wie der Objektspeicher.

33. **Der Kanalname eines externen Zählers ist übersetzt** (seit v0.18.2, ersetzt den Teil von
    DD17, der ihn für gerätegegeben hielt). Der `type` kommt aus einer GESCHLOSSENEN Liste der API
    (`gas_meter`, `water_meter`, `warm_water_meter`, `heat_meter`, `inlet_heat_meter` — genau die
    Union in `types.ts`), ist also adapter-eigener Text und wird wie jedes andere Label übersetzt
    und nachgezogen — ohne `preserve`. Nur ein Typ AUSSERHALB der Liste ist wirklich
    gerätegegeben: der behält den Rohwert (mit CR/LF-Strip) und `preserve`. Gefunden hat das das
    Objekt-Inventar-Gate beim allerersten Lauf.
34. **Jeder Datenpunkt hat eine Beschreibung oder einen begründeten Verzicht** (seit v0.18.2;
    Entscheidungs-Ablage seit 2026-09-07 in `test/self-explaining.json`). Erklärt sind
    Schein-/Blindleistung, Leistungsfaktor, Ladezyklen, die vier Batterie-Steuerwerte, Cloud- und
    v1-API-Schalter (letzterer mit der Sicherheitsfolge), WLAN-Pegel, Laufzeit, Tarif,
    Messzeitpunkt, Zähler-Kennung und der externe Zählerstand. Die 37 stummen Datenpunkt-**Arten**
    (Kennungen, Knöpfe, elektrische Grundgrößen, Zählerstände, die zwei Begleiter des externen
    Zählers) tragen je eine englische Begründung, warum ihr Name allein reicht — Muster ohne
    Namensraum, `*` = genau EIN Id-Abschnitt. **Geprüft wird das vom Flotten-Gate D08**
    (`../scripts/check-object-inventory.py` gegen `test/objects.inventory.json`), nicht mehr von
    einem Adapter-Test: es meldet den unentschiedenen Datenpunkt genauso wie das verwaiste Muster,
    das Muster, dessen Treffer alle eine Beschreibung TRAGEN, und die zu kurze Begründung. Der
    frühere `SELF_EXPLAINING`-Block in `state-defs.test.ts` prüfte dieselbe Fläche (gemessen: alle
    85 Katalog-Ids erscheinen im Inventar) und ist deshalb entfallen. ⚠️ D08 besitzt „ist
    ENTSCHIEDEN", nicht „ist GUT" — ein grüner Lauf belegt nicht, dass die Beschreibungen etwas
    erklären.

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
sechs Stück; `_all` und `_regression_*` sind AGGREGAT-Module, die die zwei Basistabellen dynamisch
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
