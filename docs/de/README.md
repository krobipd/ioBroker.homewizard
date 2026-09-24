# ioBroker.homewizard — Anleitung

Echtzeit-Energiedaten von HomeWizard-Energy-Geräten über die lokale **API v2**.

## Voraussetzungen

- Ein HomeWizard-Gerät mit API v2: **P1-Meter** (HWE-P1), **kWh-Meter** 1-phasig (HWE-KWH1 / SDM230) oder 3-phasig (HWE-KWH3 / SDM630), **Plug-In Battery** (HWE-BAT).
- Eine Firmware mit lokaler API v2 (siehe die [Kompatibilitätsliste](https://api-documentation.homewizard.com/docs/introduction) von HomeWizard). In der HomeWizard-App muss dafür nichts eingeschaltet werden: Der Schalter „Lokale API“ dort gehört zur alten v1-API und sollte aus bleiben.
- Node.js >= 22, js-controller >= 7.2.2, Admin >= 8.0.11.

Energy Socket, Watermeter und Energy Display sprechen nur die abgekündigte v1-API. Sie liegen außerhalb des Adapters und kommen auch nicht mehr dazu.

## Gerät hinzufügen

Der Adapter hat keine Gerätetabelle in den Einstellungen — Geräte stehen im Objektbaum und werden über den Knopf am Gerät selbst hinzugefügt.

**Mit automatischer Suche (Normalfall)**

1. Im Reiter **Objekte** `homewizard.0.startPairing` auf `true` setzen.
2. Innerhalb von 60 Sekunden den Knopf am HomeWizard-Gerät drücken (kWh-Meter: 1–3 Sekunden gedrückt halten).
3. Das Gerät erscheint mit einem eigenen Ordner unter der Instanz.

Das Fenster bleibt die vollen 60 Sekunden offen — mehrere Geräte lassen sich also in einem Durchgang hinzufügen.

**Mit fester IP-Adresse** — für Netze, in die die automatische Suche nicht durchkommt (eigenes VLAN, Docker ohne Host-Netzwerk):

1. Die IP-Adresse des Geräts in `homewizard.0.pairingIp` eintragen.
2. Danach `homewizard.0.startPairing` auf `true` setzen und den Knopf am Gerät drücken.

## Was angelegt wird

Jedes Gerät bekommt einen Ordner `<Produkttyp>_<Seriennummer>`. Er trägt den Produktnamen, den das Gerät meldet (z. B. „P1 Meter“) — den Namen aus der HomeWizard-App liefert die API nicht. Logzeilen nennen das Gerät als `P1 Meter (hwe-p1_5c2fafaabbcc)`, so lassen sich zwei gleiche Geräte unterscheiden. Der Ordner enthält:

| Ordner                 | Inhalt                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `info`                 | Produktname und -typ, Firmware, WLAN und Signalstärke, Laufzeit, Verbindungszustand                                                                            |
| `measurement`          | Leistung, Spannung, Strom, Frequenz, Energiezähler je Tarif, Zeitstempel                                                                                       |
| `measurement.quality`  | Spannungseinbrüche und -überhöhungen, Ausfallzähler (nur P1)                                                                                                   |
| `measurement.external` | Gas-, Wasser- und Wärmezähler, die über das P1-Meter melden; ein Zähler, der einen Tag lang nicht mehr gemeldet wird (etwa nach einem Tausch), wird entfernt   |
| `system`               | Cloud-Verbindung, Helligkeit der Status-LED (nicht am kWh-Meter), alte v1-API und Neustart (nicht an der Plug-In Battery), Identifizieren (nicht am kWh-Meter) |
| `battery`              | Lademodus, Berechtigungen, Zielleistung und Zähler — am Zähler, mit dem die Batterie gekoppelt ist                                                             |

`remove` entfernt ein Gerät samt aller Datenpunkte.

## Verbindungs-Anzeigen

- `<Gerät>.info.connected` — wahr, solange das Gerät dem Adapter antwortet. Das schließt den Abruf im Rückfall ein, nicht nur die Echtzeit-Verbindung.
- `info.connection` — wahr, solange mindestens ein Gerät antwortet.
- `info.devicesTotal` / `info.devicesOnline` / `info.devicesAllOnline` — wie viele Geräte eingerichtet sind und wie viele davon antworten. `devicesTotal` behält seinen Wert, wenn der Adapter gestoppt wird.

Messwerte kommen normalerweise etwa jede Sekunde als Push. Bricht diese Verbindung ab, fragt der Adapter stattdessen per HTTPS ab (alle 10 Sekunden, bei einem Gerät mit schwachem Empfang alle 30) und baut die Verbindung im Hintergrund wieder auf — die Daten laufen also weiter.

## Plug-In Battery steuern

Die Batterie wird als eigenes Gerät gekoppelt, die Bedienung sitzt aber am **P1- oder kWh-Meter**, mit dem sie zusammenarbeitet — dort stellt HomeWizard sie bereit:

- `battery.mode` — `zero` (hält das Haus bei Netto-Null, lädt oder entlädt dafür) oder `predictive`. `to_full` und `standby` sind laut HomeWizard veraltet: stattdessen `charge_to_full` bzw. `permissions` nutzen.
- `battery.power_w` / `battery.target_power_w` — positiv heißt Laden, negativ Entladen.
- `battery.charge_to_full` — einmalig auf 100 % laden.
- `battery.permissions` — ein JSON-Array, als Text geschrieben.

`predictive` und `charge_to_full` brauchen eine neuere Batterie-Firmware (API 2.3.0). Ältere Firmware lehnt sie ab, der Wert wird dann nicht übernommen.

## Wenn etwas nicht geht

**Die Kopplung findet das Gerät nicht.** Die automatische Suche kommt oft nicht über VLAN-Grenzen oder Docker-Brücken. Dann den Weg über die feste IP nehmen.

**Die Kopplung scheitert direkt nach dem Knopfdruck.** Der Adapter zieht den eben ausgestellten Zugang wieder zurück und bittet um einen neuen Versuch. Beim kWh-Meter den Knopf 1–3 Sekunden gedrückt halten; ein kurzer Druck reicht nicht.

**Ein Gerät steht auf nicht verbunden.** Der Adapter gibt nie auf: Er versucht die Echtzeit-Verbindung in wachsenden Abständen (bis zu 5 Minuten), sucht etwa stündlich per mDNS nach einer geänderten IP-Adresse und schaltet bei Geräten mit erkennbar schwachem Empfang auf einen schnelleren Rhythmus. Ein Zähler im Kellerflur kann stundenlang weg sein; damit er zurückkommt, ist nichts zu tun.

**„token invalid — re-pair device to fix".** Das Gerät nimmt den Zugang des Adapters nicht mehr an, meist nach einem Werksreset. Einfach neu koppeln (`startPairing` und Knopf, notfalls mit `pairingIp`) — der Adapter nimmt ein Gerät mit ungültigem Zugang an, die vorhandenen Datenpunkte bleiben erhalten.

**Meldungen über das ablaufende mitgelieferte Zertifikat.** Der Adapter bringt das HomeWizard-Stammzertifikat mit, um Gerätezertifikate zu prüfen. Lange vor dessen Ablauf liefert ein Adapter-Update ein frisches nach.

## Datenschutz und Sicherheit

- Die Zugänge der Geräte liegen verschlüsselt im Geräte-Objekt, nie in der Adapter-Konfiguration.
- Der Adapter prüft das Zertifikat jedes Geräts gegen dessen bekannte Identität — er spricht also nicht mit einem anderen Gerät, das zufällig ein HomeWizard-Zertifikat besitzt.
- Beim Entfernen eines Geräts zieht der Adapter seinen Zugang auch auf dem Gerät selbst zurück.
- Jedes ioBroker-System und jede Instanz meldet sich unter einem eigenen Namen am Gerät an — ein Test- und ein Produktivsystem am selben Zähler stören sich nicht.
- `system.api_v1_enabled` schaltet die alte v1-API am Gerät wieder ein. Diese API hat keine Verschlüsselung und keinen Zugangsschutz — jeder im Netz kann das Gerät dann lesen und steuern. Der Adapter warnt beim Einschalten.
