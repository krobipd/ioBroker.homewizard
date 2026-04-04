# CLAUDE.md — ioBroker.homewizard

> **Hinweis:** Dieses Projekt nutzt die gemeinsame ioBroker-Wissensbasis unter `../CLAUDE.md` (lokal, nicht im Git-Repo). Diese enthält allgemeine Best Practices, Standard-Konfigurationen und Workflows für alle ioBroker-Adapter-Projekte. **Bitte beide Dateien aktuell halten** — Änderungen an Standards gehören in die globale Datei, projekt-spezifisches Wissen hierher.

## Projekt-Übersicht

**ioBroker HomeWizard Adapter** — Echtzeit-Energiedaten von HomeWizard-Geräten (P1 Meter, kWh Meter, Plug-In Battery) via API v2 mit WebSocket-Push.

**Status: v0.1.3 auf npm veröffentlicht** (April 2026)
**GitHub:** https://github.com/krobipd/ioBroker.homewizard
**npm:** https://www.npmjs.com/package/iobroker.homewizard
**ioBroker Repository PR:** ioBroker/ioBroker.repositories#5749

**Runtime-Dependencies:** `@iobroker/adapter-core`, `ws` (WebSocket), `bonjour-service` (mDNS Discovery)

## HomeWizard API v2

- **Doku:** https://api-documentation.homewizard.com/docs/category/api-v2
- **Protokoll:** HTTPS (self-signed Cert) + WSS (WebSocket Secure)
- **Auth:** Bearer Token (einmaliges Pairing mit physischem Button-Druck am Gerät)
- **Echtzeit:** WebSocket pusht Messwerte ~1x/Sekunde
- **API-Version Header:** `X-Api-Version: 2`

### Endpoints

| Endpoint | Methode | Beschreibung |
|----------|---------|--------------|
| `/api` | GET | Device Info (product_name, serial, firmware, api_version) |
| `/api/user` | POST | Token erstellen (Pairing — 403 bis Button gedrückt, dann 200 + Token) |
| `/api/user` | GET | Alle User auflisten |
| `/api/user` | DELETE | User löschen (Token revoken) |
| `/api/measurement` | GET | Aktuelle Messwerte (REST Fallback) |
| `/api/telegram` | GET | Roh-Telegram vom P1 Meter (text/plain, nur HWE-P1) |
| `/api/system` | GET/PUT | System-Einstellungen (Cloud, LED, API v1, Reboot) |
| `/api/system/reboot` | PUT | Gerät neustarten |
| `/api/system/identify` | PUT | LED blinken lassen |
| `/api/batteries` | GET/PUT | Batterie-Steuerung (Mode, Permissions) |
| `/api/ws` | WSS | WebSocket für Echtzeit-Push |

### Auth-Flow (Pairing)

**Exakt wie Hue-Bridge-Pairing**, aber mit physischem Button am Gerät statt Software-Button:

1. Adapter entdeckt Gerät via mDNS (`_hwenergy._tcp`)
2. `POST /api/user {"name": "local/iobroker"}` → 403 (`user:creation-not-enabled`)
3. **User muss physisch den Button am HomeWizard-Gerät drücken!**
4. Erneuter `POST /api/user` → 200 + `{"token": "<32-char hex>"}`
5. Token wird in `encryptedNative` gespeichert
6. Alle weiteren Requests: `Authorization: Bearer <TOKEN>` + `X-Api-Version: 2`

**Wichtig:** Der User muss explizit aufgefordert werden den Button zu drücken! (Unterschied zu hueemu wo der Server den Button selbst "drückt")

### WebSocket-Flow

1. Connect: `wss://<IP>/api/ws`
2. Gerät sendet: `{"type": "authorization_requested", "data": {"api_version": "2.0.0"}}`
3. Adapter sendet (innerhalb 40s!): `{"type": "authorization", "data": {"token": "<TOKEN>"}}`
4. Gerät bestätigt: `{"type": "authorized"}`
5. Adapter subscribed: `{"type": "subscribe", "data": {"topic": "measurement"}}`
6. Gerät pusht ab jetzt Messwerte ~1x/Sekunde

**Topics:** `*`, `device`, `user`, `measurement`, `system`, `batteries`

### HTTPS / TLS

- Self-signed Cert von HomeWizard
- Hostname-Format: `appliance/{product_type}/{serial}` (z.B. `appliance/p1dongle/5c2fafaabbcc`)
- CA-Cert kann von HomeWizard heruntergeladen werden zur Validierung
- Alternativ: `rejectUnauthorized: false`

## Unterstützte Geräte

| Gerät | product_type | API v2 | WebSocket | Batterie-API |
|-------|-------------|--------|-----------|--------------|
| P1 Meter | HWE-P1 | ✅ | ✅ | ✅ (als Controller) |
| kWh Meter 1-Phase | HWE-KWH1 / SDM230 | ✅ | ✅ | ✅ (als Controller) |
| kWh Meter 3-Phase | HWE-KWH3 / SDM630 | ✅ | ✅ | ✅ (als Controller) |
| Plug-In Battery | HWE-BAT | ✅ | ✅ | (gesteuert via P1/kWh) |
| Energy Socket | HWE-SKT | Nur v1 | In Entwicklung | ❌ |
| Energy Display | — | In Entwicklung | In Entwicklung | ❌ |
| Watermeter | HWE-WTR | Nur v1 | In Entwicklung | ❌ |

## Messwerte pro Gerätetyp

### P1 Meter (HWE-P1) — Alle Felder optional

**Energie:**
- `energy_import_kwh`, `energy_import_t1_kwh` ... `t4_kwh` (Bezug, pro Tarif)
- `energy_export_kwh`, `energy_export_t1_kwh` ... `t4_kwh` (Einspeisung, pro Tarif)

**Leistung:**
- `power_w` (Gesamt, Summe aller Phasen)
- `power_l1_w`, `power_l2_w`, `power_l3_w` (pro Phase, negativ bei Einspeisung)

**Spannung/Strom:**
- `voltage_v`, `voltage_l1_v` ... `l3_v`
- `current_a`, `current_l1_a` ... `l3_a` (negativ bei Einspeisung)
- `frequency_hz`

**Netzqualität:**
- `voltage_sag_l1_count` ... `l3_count` (Spannungseinbrüche)
- `voltage_swell_l1_count` ... `l3_count` (Spannungsspitzen)
- `any_power_fail_count`, `long_power_fail_count`

**Kapazitätstarif (nur belgische Zähler):**
- `average_power_15m_w`, `monthly_power_peak_w`, `monthly_power_peak_timestamp`

**Metadaten:**
- `unique_id`, `protocol_version`, `meter_model`, `timestamp`, `tariff`

**Externe Zähler (Gas, Wasser, Wärme):**
- `external[]` Array mit `unique_id`, `type`, `timestamp`, `value`, `unit`
- Typen: `gas_meter`, `heat_meter`, `warm_water_meter`, `water_meter`, `inlet_heat_meter`

### kWh Meter 1-Phase (HWE-KWH1, SDM230)

- `energy_import_kwh`, `energy_export_kwh`
- `power_w`, `voltage_v`, `current_a`
- `apparent_current_a`, `reactive_current_a`
- `apparent_power_va`, `reactive_power_var`
- `power_factor`, `frequency_hz`

### kWh Meter 3-Phase (HWE-KWH3, SDM630)

Wie 1-Phase, plus pro Phase: `power_l1_w`...`l3_w`, `voltage_l1_v`...`l3_v`, `current_l1_a`...`l3_a`, `apparent_current_l1_a`...`l3_a`, `reactive_current_l1_a`...`l3_a`, `apparent_power_l1_va`...`l3_va`, `reactive_power_l1_var`...`l3_var`, `power_factor_l1`...`l3`

### Plug-In Battery (HWE-BAT)

- `energy_import_kwh`, `energy_export_kwh`
- `power_w`, `voltage_v`, `current_a`, `frequency_hz`
- `state_of_charge_pct` (Ladestand %)
- `cycles` (Ladezyklen)

## Batterie-Steuerung (via P1/kWh Meter)

| Feld | Version | Zugriff | Beschreibung |
|------|---------|---------|--------------|
| `mode` | 2.1.0 | R/W | `zero` (Netznull), `to_full` (Vollladen), `standby` |
| `permissions` | 2.2.0 | R/W* | `["charge_allowed", "discharge_allowed"]` (*read-only in `to_full`) |
| `battery_count` | 2.2.0 | R | Anzahl verbundener Batterien |
| `power_w` | 2.1.0 | R | Aktuelle kombinierte Leistung |
| `target_power_w` | 2.1.0 | R | Zielleistung |
| `max_consumption_w` | 2.1.0 | R | Max. Verbrauch |
| `max_production_w` | 2.1.0 | R | Max. Produktion |

## System-Einstellungen

| Feld | Zugriff | Beschreibung |
|------|---------|--------------|
| `wifi_ssid` | R | WLAN-Name |
| `wifi_rssi_db` | R | Signalstärke |
| `uptime_s` | R | Uptime in Sekunden |
| `cloud_enabled` | R/W | Cloud-Kommunikation ein/aus |
| `status_led_brightness_pct` | R/W | LED-Helligkeit 0-100% |
| `api_v1_enabled` | R/W | Legacy API v1 ein/aus (nur P1/kWh) |

## Error-Codes

| Code | Bedeutung |
|------|-----------|
| `request:invalid-json` | JSON nicht parsbar |
| `json:no-parameters-recognized` | Keine bekannten Parameter |
| `json:parameter-invalid-type:<param>` | Falscher Datentyp |
| `json:parameter-missing:<param>` | Pflichtfeld fehlt |
| `request:api-version-not-supported` | API-Version nicht unterstützt |
| `request:internal-server-error` | Interner Fehler |
| `request:too-large` | Request zu groß |
| `request:unknown-subscription` | Ungültiges WebSocket-Topic |
| `request:unknown-type` | Unbekannter WebSocket-Typ |
| `telegram:no-telegram-received` | Kein Telegram verfügbar (503) |
| `user:creation-not-enabled` | Button noch nicht gedrückt (403) |
| `user:unauthorized` | Token ungültig (401) |
| `user:no-storage` | Kein Speicherplatz für neue User |

## Architektur

```
src/
├── main.ts                  → Adapter-Klasse (Lifecycle, Pairing, Multi-Device)
└── lib/
    ├── types.ts             → Interfaces (DeviceConfig, DeviceConnection, Measurement)
    ├── cacert.ts            → HomeWizard CA-Cert + shared HTTPS Agent (HW_AGENT)
    ├── discovery.ts         → mDNS Discovery (_hwenergy._tcp), permanent laufend
    ├── homewizard-client.ts → HTTPS-Client (Token-Auth, REST-Endpoints)
    ├── websocket-client.ts  → WSS-Client (Echtzeit-Messwerte, Auto-Reconnect)
    └── state-manager.ts     → State CRUD + Cleanup
```

## Design-Entscheidungen

### Multi-Device in einer Instanz (wie hueemu)
- Pairing-Datenpunkt (`startPairing`) — User aktiviert, drückt Button am Gerät, Adapter legt Gerät automatisch an
- mDNS Discovery (`_hwenergy._tcp`) läuft **permanent** (nicht nur beim Pairing)
- IP wird NICHT in Config gespeichert — kommt zur Laufzeit von mDNS
- `DeviceConfig` (persistent): serial, token, productType, productName
- `DeviceConnection` (runtime): ip (von mDNS), wsClient, pollTimer, reconnectTimer
- Pro Gerät: eigene WebSocket-Verbindung + Token in encryptedNative
- Neues Gerät: Pairing nochmal aktivieren, Button am neuen Gerät drücken, fertig

### mDNS ≠ Daten-Transport
- **mDNS** = Telefonbuch: Gerät meldet sich mit Name, IP, Port, Metadaten (TXT records)
- **WebSocket** = Daten-Transport: Adapter verbindet sich aktiv zum Gerät per IP → WSS-Push ~1/s
- mDNS liefert die IP, WebSocket nutzt die IP für die Datenverbindung
- Bei IP-Änderung (DHCP): mDNS meldet neue IP → Adapter reconnected automatisch

### Pairing-Flow (Unterschied zu hueemu!)
- **hueemu:** Server "drückt" Button selbst (Software-Datenpunkt)
- **HomeWizard:** User muss **physisch zum Gerät** gehen und Button drücken
- UI/Log muss explizit sagen: "Bitte jetzt den Button am Gerät drücken!"

### WebSocket als Primär, REST als Fallback
- Normal: WebSocket pusht ~1/s Messwerte
- Bei WS-Disconnect: automatisch neu verbinden + re-auth
- Wenn WS dauerhaft fehlschlägt: Fallback auf REST-Polling (`GET /api/measurement`)

### API v1 wird NICHT unterstützt
- v1 hat keine Auth (unsicher), kein WebSocket (kein Echtzeit), Gas-Felder deprecated
- Geräte die nur v1 unterstützen (Energy Socket, Watermeter) werden erst unterstützt wenn HomeWizard v2 dafür released

## State-Struktur (geplant)

```
homewizard.0.
├── info.connection                    (bool, Gesamtstatus)
├── startPairing                       (bool, button — Pairing-Modus aktivieren)
└── {productType}_{serial}/            z.B. p1dongle_5c2fafaabbcc
    ├── info.productName               (string, "P1 Meter")
    ├── info.productType               (string, "HWE-P1")
    ├── info.firmware                  (string, "6.00")
    ├── info.connected                 (bool, WebSocket-Status dieses Geräts)
    ├── info.wifi_rssi_db              (number, Signalstärke)
    ├── info.uptime_s                  (number, Uptime)
    ├── power_w                        (number, Gesamtleistung W)
    ├── power_l1_w ... l3_w            (number, pro Phase W)
    ├── voltage_l1_v ... l3_v          (number, pro Phase V)
    ├── current_l1_a ... l3_a          (number, pro Phase A)
    ├── frequency_hz                   (number, Hz)
    ├── energy_import_kwh              (number, Bezug gesamt kWh)
    ├── energy_import_t1_kwh ... t4    (number, pro Tarif kWh)
    ├── energy_export_kwh              (number, Einspeisung gesamt kWh)
    ├── energy_export_t1_kwh ... t4    (number, pro Tarif kWh)
    ├── tariff                         (number, aktiver Tarif)
    ├── quality/                       (Netzqualität)
    │   ├── voltage_sag_l1_count ...
    │   ├── voltage_swell_l1_count ...
    │   ├── power_fail_count
    │   └── long_power_fail_count
    ├── external/                      (Gas, Wasser, Wärme)
    │   └── {type}_{id}/
    │       ├── value                  (number)
    │       ├── unit                   (string)
    │       └── timestamp              (string)
    ├── battery/                       (nur wenn Batterien verbunden)
    │   ├── mode                       (string, R/W: zero/to_full/standby)
    │   ├── permissions                (string, R/W: JSON Array)
    │   ├── battery_count              (number)
    │   ├── power_w                    (number)
    │   ├── target_power_w             (number)
    │   ├── max_consumption_w          (number)
    │   └── max_production_w           (number)
    └── system/                        (System-Steuerung)
        ├── cloud_enabled              (bool, R/W)
        ├── status_led_brightness_pct  (number, R/W, 0-100)
        ├── api_v1_enabled             (bool, R/W)
        ├── reboot                     (bool, button)
        └── identify                   (bool, button)
```

## Bestehende Adapter-Situation

- **Kein brauchbarer Adapter vorhanden** (Stand April 2026)
- `Superbear88/ioBroker.p1_homewizard`: 0 Stars, 1 Commit, JavaScript, verlassen
- Adapter-Request #14 bei ioBroker/AdapterRequests: seit 2018 offen, veraltet
- Im ioBroker Forum: keine Treffer für "homewizard"
- **Feld ist komplett frei** für einen gut gemachten TypeScript-Adapter mit v2 + WebSocket

## Vergleich API v1 vs v2

| Aspekt | API v1 | API v2 |
|--------|--------|--------|
| Auth | Keine (offen!) | Bearer Token + HTTPS |
| Echtzeit | Polling only | WebSocket (~1/s Push) |
| Endpoints | `/api/v1/data` | `/api/measurement`, `/api/system`, `/api/batteries` |
| Externe Zähler | Flache Felder (deprecated!) | Strukturiertes `external[]` Array |
| Batterien | Nicht unterstützt | Voll unterstützt |
| System-Control | Minimal | Cloud, LED, API v1, Reboot, Identify |
| Zukunft | Gas-Felder werden entfernt | Aktiv entwickelt (2.1.0, 2.2.0) |

## Test-Abdeckung

```
test/
├── testClient.ts       → HomeWizardApiError (JSON/non-JSON, status codes) (9 Tests)
├── testDiscovery.ts    → mDNS Discovery (lifecycle, parseService, TXT) (16 Tests)
├── testWebSocket.ts    → WebSocket (auth flow, messages, close) (13 Tests)
├── testStateManager.ts → StateManager (prefix, measurement, system, battery, external) (22 Tests)
└── testPackageFiles.ts → @iobroker/testing Package-Validierung (69 Tests)

Total: 129 Tests (alle TypeScript)
```

## Versionshistorie

| Version | Datum | Änderungen |
|---------|-------|------------|
| 0.1.3 | 2026-04-04 | IP aus Config entfernt, mDNS Discovery permanent, automatische IP-Updates |
| 0.1.2 | 2026-04-04 | HomeWizard CA-Cert gebündelt, TLS-Validierung statt rejectUnauthorized |
| 0.1.1 | 2026-04-04 | 129 Unit-Tests, Dependabot limit 15 |
| 0.1.0 | 2026-04-04 | Initial release: API v2, WebSocket, mDNS, Pairing |

## Befehle

```bash
npm run build            # Production build (esbuild + tsc type-check)
npm run build:test       # Test build (tsc, output to build/)
npm test                 # Build + run all tests
npm run lint             # ESLint
npm run check            # TypeScript type-check only
```

## TLS-Implementierung

- HomeWizard CA-Cert ("Appliance Access CA", gültig bis 2031) in `src/lib/cacert.ts` gebündelt
- Shared `https.Agent` mit `ca` + `rejectUnauthorized: true` + `checkServerIdentity: () => undefined`
- Cert-Chain wird validiert, Hostname-Check übersprungen (Geräte-Certs nutzen `appliance/type/serial` als CN)
- Gleicher Ansatz wie Home Assistant Integration (`python-homewizard-energy`)
- Agent wird für HTTPS-Client UND WebSocket-Client wiederverwendet

## Noch zu klären

- [ ] WebSocket: Verhalten bei Verbindungsverlust — sendet das Gerät ein Close-Frame? (API-Doku schweigt dazu, kein Ping/Pong dokumentiert → Reconnect mit Backoff ist korrekt)
- [ ] krobis P1 Meter: Welche Felder liefert der österreichische Zähler tatsächlich?
