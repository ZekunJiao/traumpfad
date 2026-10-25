# Traumpfad · 27 Tage über die Alpen

Eine lokale Reisepräsentation für deinen Mac: 3D-Satellitenkarte, geführter Flug, Fotostopps, Tagesgalerien und freies Erkunden. Deine eigenen Bilder werden nicht hochgeladen.

## Starten

Voraussetzung: macOS und Node.js ab Version 22. Die Abhängigkeiten sind im Projekt bereits installiert. Für eine neue Installation einmal `npm install` ausführen.

```sh
cd /Users/zek/Documents/ChatGPT/Traumpfad
npm start
```

Danach [http://localhost:5173](http://localhost:5173) öffnen. Mit `Ctrl+C` im Terminal beenden. Alternativ `Start-Traumpfad.command` im Finder doppelklicken und den angezeigten Link öffnen. Bei belegtem Port: `PORT=5174 npm start`.

Ohne Mapbox-Schlüssel funktioniert die schematische Vorschau einschließlich Vortragssteuerung, Bildplätzen und Galerien. Für Satellitenbilder und 3D-Gelände oben auf **Satellitenkarte verbinden** klicken und einen öffentlichen Mapbox-Token (`pk.…`) eingeben. Er wird in diesem Browser gespeichert und kann in den Einstellungen wieder entfernt werden. Alternativ `.env.example` nach `.env` kopieren und `MAPBOX_PUBLIC_TOKEN` eintragen. Der Server muss danach neu gestartet werden. Keine geheimen Mapbox-Tokens (`sk.…`) verwenden.

Die Karte benötigt Internet und WebGL2. Ein Mapbox-Schlüssel ist für den Live-Test der Satellitenansicht erforderlich. Die Kartenattribution bleibt eingeblendet. Paketdateien werden lokal ausgeliefert.

Bei Verbindungsproblemen in den Einstellungen **Schlüssel direkt bei Mapbox prüfen** wählen. Die Prüfung verwendet den eingegebenen Schlüssel oder, bei leerem Feld, den bereits gespeicherten Schlüssel. Sie unterscheidet die offizielle Token-Gültigkeit von der Erreichbarkeit der Satellitenbilder (JPEG und WebP) und der Höhendaten. Ein `TokenValid` bedeutet nicht automatisch, dass das Konto jede Kartenressource abrufen darf. Bei HTTP 429 endet die Prüfung ohne weitere Ressourcenanfragen; bei endgültigen Kartenfehlern stoppt die App die Karteninstanz. Fehlermeldungen geben den Schlüssel nicht aus.

Unter `http://localhost:5173/?diagnose=1` startet die App ohne automatische Kachelladung. Dort kann der gespeicherte Schlüssel mit einzelnen Ressourcenanfragen geprüft werden. Wenn eine Karte in der aktuellen Sitzung bereits fehlgeschlagen ist, prüft der Knopf stattdessen die betroffene Satellitenkachel direkt und mit der ursprünglichen Karten-Sitzung. Vom Browser zugängliche Antwortheader zu Wartezeit, Anfragegrenze und Anfragekennung werden mit angezeigt.

Die Karte lädt maximal vier Bilder gleichzeitig und startet noch nicht gültig im nativen Browsercache vorhandene Mapbox-Kachelanfragen mit mindestens 150 ms Abstand. Bereits gespeicherte, gültige Kacheln passieren diese Warteschlange sofort. Abgebrochene Anfragen verlassen die Warteschlange. Schlüssel und Mapbox-Sitzungsparameter werden unverändert an das Mapbox-SDK übergeben; es verwaltet Abruf, Wiederverwendung und Ablaufzeiten selbst.

### Browsercache ausprobieren

Mapbox GL JS verwendet bereits seinen eigenen persistenten Browsercache `mapbox-tiles` zusätzlich zum normalen HTTP-Cache. In **⚙ → Karten im Browser speichern → Browsercache prüfen** wird angezeigt, wie viele Einträge vorhanden und laut Ablaufzeit noch gültig sind. Diese Prüfung liest ausschließlich den lokalen Speicher und sendet keine Kartenanfragen. Sie zählt den zusätzlichen Mapbox-Cache; der normale HTTP-Cache ist darüber nicht vollständig einsehbar.

Eine Etappe laden und abspielen, dann eine andere Etappe wählen und zur ersten zurückkehren. Auch nach einem Neuladen der App können gültige Einträge wiederverwendet werden. Immer denselben Browser und `http://localhost:5173` verwenden; andere Browserprofile und Ports haben eigene Speicherbereiche. Private Fenster und das Löschen der Browserdaten können die Speicherung verhindern oder entfernen.

Die zusätzlichen Kacheln im Arbeitsspeicher werden auf 64 bis 256 Einträge pro Quelle begrenzt. Der persistente Cache bleibt der native Mapbox-Cache mit dessen eigener Größenverwaltung und Ablaufprüfung; die App erweitert seine Speicherdauer nicht. Er ist keine vollständige Offline-Sicherung aller Etappen. Ein Backend-Cache oder ein zusätzlicher Service Worker wird nicht verwendet.

### Kamera beim Start

Beim Klick auf eine Etappe fliegt die Karte in etwa 2,6 Sekunden zu deren Ausgangspunkt. **Die Reise beginnen** und **▶** führen anschließend mit einem etwa 2,2 Sekunden langen Übergang aus der sichtbaren Kameraposition in die Vogelperspektive des Routenflugs. Während des Anflugs und beim Warten auf benötigte Höhendaten bleibt der Routenfortschritt stehen. Pause hält auch einen laufenden Anflug an; Fortsetzen beginnt aus der zuletzt sichtbaren Kameraposition. Schnelle Etappenwechsel verwerfen die vorherige Kamerabewegung. Die Systemeinstellung für reduzierte Bewegung wird berücksichtigt.

Neue Konten ohne Zahlungsmethode haben einen eingeschränkten Testzugang. Laut [Mapbox-Dokumentation](https://docs.mapbox.com/accounts/guides/signup/#limits) ist die Raster Tiles API für unsere Satellitenbilder dort nicht verfügbar, auch bei gültigem Schlüssel und bestätigter E-Mail-Adresse. Für diesen Zugriff muss in der [Mapbox-Konsole](https://console.mapbox.com/) eine Zahlungsmethode hinterlegt werden. Dabei gelten weiterhin monatliche Freikontingente; Nutzung darüber hinaus wird berechnet. Falls beim Wechsel der Token erneuert wird, muss auch der Schlüssel in der App ersetzt werden. Die App verändert keine Kontofreigaben oder Zahlungsdaten. HTTP 429 kann außerdem auf ein Anfragelimit hinweisen und beweist allein keine Kontosperre. Siehe auch [Demo-Zugriff bei Mapbox](https://docs.mapbox.com/accounts/guides/demo-access/).

## Stand der Inhalte

Enthalten sind **sieben ausdrücklich schematische Beispieletappen, zehn Fotostopps und elf Bildplätze**. Es wurden keine eigenen Reisefotos, Reisedaten oder Erlebnisse erfunden. Die Verbindungen zwischen den Beispielorten sind **keine Wandertracks** und eignen sich nicht zur Navigation. Die grobe Etappenfolge orientiert sich an der [klassischen Übersicht München–Venedig](https://www.alpin.de/touren/reportagen/6320/artikel_info__muenchen_-_venedig.html); sie muss mit deinen tatsächlichen Tagen abgeglichen werden.

Die Struktur ist auf beliebig viele Etappen vorbereitet. Alle 27 persönlichen Reisetage werden ergänzt, sobald ihre Daten und Inhalte vorliegen.

## Bedienung

| Aktion | Bedienung |
| --- | --- |
| Reise starten | „Die Reise beginnen“ |
| Flug starten / pausieren | Play-Schaltfläche oder Leertaste |
| Nächster / vorheriger Fotostopp | Transporttasten oder Pfeil rechts / links |
| Fotostopp fortsetzen | „Weiter auf dem Weg“ oder Leertaste |
| Bilder innerhalb eines Fotostopps | Bildpfeile oder Pfeiltasten im Dialog |
| Tagesgalerie | „Tagesgalerie öffnen“ oder `G` |
| Dialog schließen | Kreuz oder `Escape` |
| Vollbild | Schaltfläche oben rechts oder `F` |
| Etappe überspringen | Etappe links auswählen |
| Gesamte Strecke einrahmen | „Übersicht“ |
| Frei navigieren | Karte mit der Maus steuern oder „Erkunden“ wählen; der Flug pausiert. Mit „Präsentieren“ zum gespeicherten Stand zurück |
| Karte zoomen | Mausrad / Trackpad scrollen oder Doppelklick; Umschalt + Doppelklick zoomt heraus |
| Karte verschieben | Linke Maustaste halten und ziehen |
| Kamera drehen / neigen | Rechte Maustaste halten und seitlich / nach oben oder unten ziehen |

Die Maussteuerung gilt für die verbundene Mapbox-Karte. Beim ersten Zoom oder Ziehen wechselt die App ohne neuen Anflug ins Erkunden und hält den Präsentationsstand fest. „Präsentieren“ führt die Kamera zum gespeicherten Stand zurück; ▶ setzt den Flug fort. Automatische Kamerafahrten lösen diesen Wechsel nicht aus.

An Fotostopps und am Ende einer Etappe pausiert der Flug. Nach dem letzten Tag startet Play die Reise erneut. Beim Wechsel in einen anderen Browser-Tab wird der Flug pausiert. Im Vollbild bleiben die Quellenangaben sichtbar. Auf schmalen Bildschirmen steht die Etappenliste unter der Karte.

## Eigene Fotos importieren

1. In der Mac-Fotos-App die Bilder auswählen und **Ablage → Exportieren → Unbearbeitetes Original exportieren** wählen.
2. Im vorhandenen Ordner `Material/fotos-originale/` speichern. HEIC, JPEG, PNG und TIFF sind möglich; Live-Photo-Videodateien werden in dieser Version nicht importiert.
3. In `app/data/journey.json` für die passenden Etappen `date` im Format `JJJJ-MM-TT` eintragen. Die Beispieldaten enthalten absichtlich keine Reisedaten.
4. Import starten:

```sh
npm run import
```

Anderer Quellordner:

```sh
npm run import -- --source "/absoluter/Pfad/zu/Fotos"
```

Der Import liest EXIF-Aufnahmezeiten mit ExifTool und erstellt mit dem macOS-Werkzeug `sips` JPEGs bis maximal 2560 Pixel und Vorschaubilder bis maximal 560 Pixel. Kleinere Bilder werden nicht vergrößert. Die EXIF-Bildausrichtung bleibt erhalten. Originaldateien werden ausschließlich gelesen. Der komplette SHA-256-Dateihash verhindert doppelte Einträge bei erneuten Importen oder umbenannten Dateikopien.

Vorhandene IDs, Beschriftungen und Tageszuordnungen bleiben beim erneuten Import erhalten. Noch nicht zugeordnete Fotos können anhand nachgetragener Etappendaten zugeordnet werden. Beschriftungen für importierte Fotos stehen im Feld `caption`; eine manuelle Tageszuordnung erfolgt über `stageId` und `assignment: "manual"`.

`Material/import-report.json` nennt neue Dateien, bestehende Dateien, Fehler und Fotos zur manuellen Prüfung. Fehlende Aufnahmezeiten, unbekannte Tage und mehrere Etappen mit demselben Datum werden nicht geraten. Das Erstellungsdatum der exportierten Datei wird **nicht** als Aufnahmedatum verwendet. Eine in EXIF gespeicherte Zeitzone wird nach `Europe/Berlin` umgerechnet. Ohne Zeitzone gilt die gespeicherte Kamerazeit als lokale Reisezeit.

GPS-Koordinaten in Fotos werden für diese Reise nicht vorausgesetzt. Der Import erzeugt keine vermeintlichen Aufnahmeorte. Alle importierten Fotos mit passender `stageId` erscheinen in der Tagesgalerie. Nicht zugeordnete Fotos stehen im Importbericht und im Manifest.

## Etappen, Routen und Fotostopps pflegen

Die zentrale Inhaltsdatei ist `app/data/journey.json`. Sie verbindet:

- `chapters`: Kapitelname und geordnete `stageIds`.
- `stages`: ID, Tagesnummer, Datum, Start, Ziel, Beschreibung, Übernachtung, Routendatei, Herkunft, Flugdauer und Fotostopps.
- `photos`: ID, Webdatei, Vorschaubild, Aufnahmezeit, `stageId`, Titel, Bildunterschrift und optionaler Bildnachweis.
- `stories`: Motivation und Vorbereitung sowie Ankunft und Rückblick. Abschnitte können über `photoId` ein eigenes Bild zeigen.

Die Reihenfolge der `stages` bestimmt den Reiseablauf. Neue Etappen erhalten eindeutige IDs (zum Beispiel `tag-08`), eine `routeFile` unter `routes/`, eine positive `durationSeconds` und ein `stops`-Array. Ordne sie außerdem einem Kapitel zu. Datumsangaben können bis zur Klärung `null` bleiben. Erst wenn die Inhalte persönlich überprüft sind, `demo` auf `false` setzen.

### Eine echte Route einlesen

```sh
npm run route -- --stage tag-01 --file "/absoluter/Pfad/etappe-01.gpx" --kind reconstructed --source-url "https://quelle.example/route"
```

`--source-url` ist optional und sollte auf die tatsächliche Datenquelle zeigen. Für eine eigene GPS-Aufzeichnung `--kind recorded` verwenden. Standard ist `reconstructed`. Lizenz und erforderliche Quellenangaben der gewählten Routendaten beachten und bei der Herkunft dokumentieren.

Unterstützt werden GPX mit einem zusammenhängenden Track oder einer Route sowie GeoJSON als einzelner `LineString` beziehungsweise Feature mit `LineString`. Mehrere getrennte GPX-Abschnitte werden abgelehnt, damit keine erfundene Verbindung entsteht. Start/Ziel allein reichen nicht für einen tatsächlichen Wandertrack. Eine passende Wegführung muss recherchiert und mit deinen Varianten abgeglichen werden.

Nach dem Austausch einer Route alle zugehörigen Fotostopps prüfen: Ihre Position wird als Anteil der **Streckenlänge** gespeichert. Eine veränderte Route kann diese Position verschieben.

### Einen Fotostopp mit eigenen Bildern verbinden

```json
{
  "id": "mein-stopp-01",
  "progress": 0.45,
  "title": "Ein besonderer Hüttenabend",
  "approximate": true,
  "caption": "Hier steht deine eigene Geschichte.",
  "photoIds": ["foto-ID-aus-dem-Import", "weitere-foto-ID"]
}
```

`progress` liegt zwischen 0 und 1 und bedeutet hier 45 Prozent der Strecke. `approximate` bleibt bei geschätzten Aufnahmeorten `true`. Nur diese bewusst gesetzten Fotostopps erscheinen als Kartenmarker. Andere Tagesbilder erhalten keinen Standort. Die Bildunterschrift eines Fotos hat Vorrang vor der allgemeinen Stoppgeschichte, wenn sie ausgefüllt ist. Die schematischen Fotostopps und Bildplätze beim Einpflegen deiner eigenen Reise ersetzen oder entfernen.

## Prüfen

```sh
npm run validate
npm test
```

Die Validierung prüft IDs, Referenzen, Daten, Routengeometrien und vorhandene Bildkopien. Die Tests decken unter anderem die Pause an Fotostopps, Etappenwechsel, Wiederaufnahme nach Erkunden, Entfernungsberechnung, Zeitzonen, fehlende Metadaten, wiederholten Fotoimport, Originalschutz und GPX-Segmente ab. Importtests laufen isoliert mit künstlich erzeugten Testbildern in temporären Ordnern.

Der Kameraflug nutzt eine geglättete Position hinter der Route und Höhenabfragen entlang des Sichtkorridors. Seine konkrete Wirkung und Geländeabstände müssen vor dem Vortrag mit einem Mapbox-Schlüssel an deinen tatsächlichen Bergetappen im Browser geprüft werden.

## Projektaufbau und lokale Daten

`app/` enthält ausschließlich die im Browser benötigte App, Reisedaten und abgeleitete Webbilder. `scripts/` enthält lokalen Server und Importwerkzeuge. `Material/` enthält Originale und Importbericht. Originale, Webfotos, `.env` und Importbericht sind in Git ausgeschlossen. Der Server bindet nur an die lokale Loopback-Adresse und liefert ausschließlich App-Dateien und die beiden Mapbox-Paketdateien aus; die Originale und `.git` sind nicht über HTTP erreichbar.

Grundlagen: [Mapbox-Kameraflug](https://docs.mapbox.com/mapbox-gl-js/example/free-camera-path/), [Standard Satellite](https://docs.mapbox.com/map-styles/reference/standard-satellite/), [ExifTool für Node](https://github.com/photostructure/exiftool-vendored.js/).
