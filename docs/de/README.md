# ioBroker.homewizard — Anleitung

Echtzeit-Energiedaten von HomeWizard-Energy-Geräten über die lokale **API v2**.

## Voraussetzungen

- Ein HomeWizard-Gerät mit API v2: **P1-Meter** (HWE-P1), **kWh-Meter** 1-phasig (HWE-KWH1 / SDM230) oder 3-phasig (HWE-KWH3 / SDM630), **Plug-In Battery** (HWE-BAT).
- Eine Firmware, die die lokale API v2 kann, und die lokale API in der HomeWizard-App eingeschaltet.
- Node.js >= 22, js-controller >= 7.2.2, Admin >= 8.0.11.

Energy Socket, Watermeter und Energy Display sprechen nur die abgekündigte v1-API. Sie liegen außerhalb des Adapters und kommen auch nicht mehr dazu.

## Gerät hinzufügen

Der Adapter hat keine Gerätetabelle in den Einstellungen — Geräte stehen im Objektbaum und werden über den Knopf am Gerät selbst hinzugefügt.

**Mit automatischer Suche (Normalfall)**

1. Im Reiter **Objekte** `homewizard.0.startPairing` auf `true` setzen.
2. Innerhalb von 60 Sekunden den Knopf am HomeWizard-Gerät drücken.
3. Das Gerät erscheint mit einem eigenen Ordner unter der Instanz.

Das Fenster bleibt die vollen 60 Sekunden offen — mehrere Geräte lassen sich also in einem Durchgang hinzufügen.

**Mit fester IP-Adresse** — für Netze, in die die automatische Suche nicht durchkommt (eigenes VLAN, Docker ohne Host-Netzwerk):

1. Die IP-Adresse des Geräts in `homewizard.0.pairingIp` eintragen.
2. Danach `homewizard.0.startPairing` auf `true` setzen und den Knopf am Gerät drücken.

## Was angelegt wird

Jedes Gerät bekommt einen Ordner `<Produkttyp>_<Seriennummer>` mit:

| Ordner | Inhalt |
| --- | --- |
| `info` | Produktname und -typ, Firmware, WLAN und Signalstärke, Laufzeit, Verbindungszustand |
| `measurement` | Leistung, Spannung, Strom, Frequenz, Energiezähler je Tarif, Zeitstempel |
| `measurement.quality` | Spannungseinbrüche und -überhöhungen, Ausfallzähler (nur P1) |
| `measurement.external` | Gas-, Wasser- und Wärmezähler, die über das P1-Meter melden |
| `system` | Cloud-Verbindung, Helligkeit der Status-LED, alte v1-API, Knöpfe für Neustart und Identifizieren |
| `battery` | Lademodus, Berechtigungen, Zielleistung und Zähler — am Zähler, mit dem die Batterie gekoppelt ist |

`remove` entfernt ein Gerät samt aller Datenpunkte.

## Verbindungs-Anzeigen

- `<Gerät>.info.connected` — wahr, solange das Gerät dem Adapter antwortet. Das schließt den Abruf im Rückfall ein, nicht nur die Echtzeit-Verbindung.
- `info.connection` — wahr, solange mindestens ein Gerät antwortet.
- `info.devicesTotal` / `info.devicesOnline` / `info.devicesAllOnline` — wie viele Geräte eingerichtet sind und wie viele davon antworten. `devicesTotal` behält seinen Wert, wenn der Adapter gestoppt wird.

Messwerte kommen normalerweise etwa jede Sekunde als Push. Bricht diese Verbindung ab, fragt der Adapter stattdessen per HTTPS ab (alle 10 Sekunden, bei einem Gerät mit schwachem Empfang alle 30) und baut die Verbindung im Hintergrund wieder auf — die Daten laufen also weiter.

## Plug-In Battery steuern

Die Batterie wird als eigenes Gerät gekoppelt, die Bedienung sitzt aber am **P1- oder kWh-Meter**, mit dem sie zusammenarbeitet — dort stellt HomeWizard sie bereit:

- `battery.mode` — `zero`, `to_full`, `standby` oder `predictive`.
- `battery.charge_to_full` — einmalig auf 100 % laden.
- `battery.permissions` — ein JSON-Array, als Text geschrieben.

`predictive` und `charge_to_full` brauchen eine neuere Batterie-Firmware (API 2.3.0). Ältere Firmware lehnt sie ab, der Wert wird dann nicht übernommen.

## Wenn etwas nicht geht

**Die Kopplung findet das Gerät nicht.** Die automatische Suche kommt oft nicht über VLAN-Grenzen oder Docker-Brücken. Dann den Weg über die feste IP nehmen.

**Die Kopplung scheitert direkt nach dem Knopfdruck.** Der Adapter zieht den eben ausgestellten Zugang wieder zurück und bittet um einen neuen Versuch. Prüfen, ob die lokale API in der HomeWizard-App eingeschaltet ist.

**Ein Gerät steht auf nicht verbunden.** Der Adapter gibt nie auf: Er versucht die Echtzeit-Verbindung in wachsenden Abständen (bis zu 5 Minuten), sucht etwa stündlich per mDNS nach einer geänderten IP-Adresse und schaltet bei Geräten mit erkennbar schwachem Empfang auf einen schnelleren Rhythmus. Ein Zähler im Kellerflur kann stundenlang weg sein; damit er zurückkommt, ist nichts zu tun.

**„token invalid — re-pair device to fix".** Das Gerät nimmt den Zugang des Adapters nicht mehr an, meist nach einem Werksreset. Einfach neu koppeln — die vorhandenen Datenpunkte bleiben erhalten.

**Meldungen über das ablaufende mitgelieferte Zertifikat.** Der Adapter bringt das HomeWizard-Stammzertifikat mit, um Gerätezertifikate zu prüfen. Lange vor dessen Ablauf liefert ein Adapter-Update ein frisches nach.

## Datenschutz und Sicherheit

- Die Zugänge der Geräte liegen verschlüsselt im Geräte-Objekt, nie in der Adapter-Konfiguration.
- Der Adapter prüft das Zertifikat jedes Geräts gegen dessen bekannte Identität — er spricht also nicht mit einem anderen Gerät, das zufällig ein HomeWizard-Zertifikat besitzt.
- Beim Entfernen eines Geräts zieht der Adapter seinen Zugang auch auf dem Gerät selbst zurück.
- `system.api_v1_enabled` schaltet die alte v1-API am Gerät wieder ein. Diese API hat keine Verschlüsselung und keinen Zugangsschutz — jeder im Netz kann das Gerät dann lesen und steuern. Der Adapter warnt beim Einschalten.
