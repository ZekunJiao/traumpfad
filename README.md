# Traumpfad · 27 Tage über die Alpen

Eine lokale Reisepräsentation für deinen Mac: 3D-Satellitenkarte, geführter Flug, Fotostopps, Tagesgalerien und freies Erkunden. Deine eigenen Bilder werden nicht hochgeladen.

## Starten

Voraussetzung: macOS und Node.js ab Version 24. Die Abhängigkeiten sind im Projekt bereits installiert. Für eine neue Installation einmal `npm install` ausführen.

```sh
cd /Users/zek/Documents/ChatGPT/Traumpfad
npm start
```

Danach [http://localhost:5173](http://localhost:5173) öffnen. Mit `Ctrl+C` im Terminal beenden. Alternativ `Start-Traumpfad.command` im Finder doppelklicken und den angezeigten Link öffnen. Bei belegtem Port: `PORT=5174 npm start`.

Ohne Mapbox-Schlüssel funktioniert die schematische Vorschau einschließlich Vortragssteuerung, Bildplätzen und Galerien. Für Satellitenbilder und 3D-Gelände oben auf **Satellitenkarte verbinden** klicken und einen öffentlichen Mapbox-Token (`pk.…`) eingeben. Er wird für die aktuelle Browser-Adresse gespeichert und beim nächsten Öffnen automatisch verwendet. In den Einstellungen zeigt ein Hinweis den Speicherstatus an; das leere Eingabefeld dient nur zum Ersetzen des Schlüssels. Ein Wechsel zwischen `localhost:5173`, `localhost:5174`, `127.0.0.1` oder verschiedenen Browsern verwendet getrennte Speicher. Der Schlüssel kann in den Einstellungen wieder entfernt werden. Alternativ `.env.example` nach `.env` kopieren und `MAPBOX_PUBLIC_TOKEN` eintragen. Der Server muss danach neu gestartet werden. Keine geheimen Mapbox-Tokens (`sk.…`) verwenden.

Die Karte benötigt Internet und WebGL2. Ein Mapbox-Schlüssel ist für den Live-Test der Satellitenansicht erforderlich. Die Kartenattribution bleibt eingeblendet. Paketdateien werden lokal ausgeliefert.

Bei Verbindungsproblemen in den Einstellungen **Schlüssel direkt bei Mapbox prüfen** wählen. Die Prüfung verwendet den eingegebenen Schlüssel oder, bei leerem Feld, den bereits gespeicherten Schlüssel. Sie unterscheidet die offizielle Token-Gültigkeit von der Erreichbarkeit der Satellitenbilder (JPEG und WebP) und der Höhendaten. Ein `TokenValid` bedeutet nicht automatisch, dass das Konto jede Kartenressource abrufen darf. Bei HTTP 429 endet die Prüfung ohne weitere Ressourcenanfragen; bei endgültigen Kartenfehlern stoppt die App die Karteninstanz. Fehlermeldungen geben den Schlüssel nicht aus.

Unter `http://localhost:5173/?diagnose=1` startet die App ohne automatische Kachelladung. Dort kann der gespeicherte Schlüssel mit einzelnen Ressourcenanfragen geprüft werden. Wenn eine Karte in der aktuellen Sitzung bereits fehlgeschlagen ist, prüft der Knopf stattdessen die betroffene Satellitenkachel direkt und mit der ursprünglichen Karten-Sitzung. Vom Browser zugängliche Antwortheader zu Wartezeit, Anfragegrenze und Anfragekennung werden mit angezeigt.

Satelliten- und DEM-Kacheln laufen über den lokalen Festplattencache. Gespeicherte Treffer werden ohne Ablaufprüfung wiederverwendet und benötigen keine erneute Mapbox-Anfrage. Für fehlende Bilder koordiniert der Server auch zwischen Worktrees höchstens zwei gleichzeitige Mapbox-Anfragen mit mindestens 150 ms Startabstand. Sichtbare Kartenanfragen haben Vorrang vor Vorabdownloads. Echte SDK-Sitzungsparameter werden upstream erhalten; der Schlüssel wird nur in einem lokalen Anfrageheader übergeben. Andere Kartenressourcen und Dienste verwenden weiterhin Mapbox direkt.

### Browsercache ausprobieren

Mapbox GL JS verwendet bereits seinen eigenen persistenten Browsercache `mapbox-tiles` zusätzlich zum normalen HTTP-Cache. In **⚙ → Karten im Browser speichern → Browsercache prüfen** wird angezeigt, wie viele Einträge vorhanden und laut Ablaufzeit noch gültig sind. Diese Prüfung liest ausschließlich den lokalen Speicher und sendet keine Kartenanfragen. Sie zählt den zusätzlichen Mapbox-Cache; der normale HTTP-Cache ist darüber nicht vollständig einsehbar.

Eine Etappe laden und abspielen, dann eine andere Etappe wählen und zur ersten zurückkehren. Auch nach einem Neuladen der App können gültige Einträge wiederverwendet werden. Immer denselben Browser und `http://localhost:5173` verwenden; andere Browserprofile und Ports haben eigene Speicherbereiche. Private Fenster und das Löschen der Browserdaten können die Speicherung verhindern oder entfernen.

Die zusätzlichen Kacheln im Arbeitsspeicher werden auf bis zu 1.024 Einträge pro Quelle begrenzt. Der persistente Cache bleibt der native Mapbox-Cache mit dessen eigener Größenverwaltung und Ablaufprüfung; die App erweitert seine Speicherdauer nicht. Er ist keine vollständige Offline-Sicherung aller Etappen. Satellitenbilder und Höhendaten verwenden zusätzlich den nachfolgend beschriebenen Festplattencache. Ein Service Worker wird nicht verwendet. Die Browsercache-Anzeige erfasst diesen separaten Festplattenspeicher nicht.

### Karten auf diesem Mac speichern

Unter **⚙ → Karten auf diesem Mac speichern** werden Belegung, gespeicherte Kacheln und lokale Treffer angezeigt. Der zusätzliche Cache liegt bei diesem Projekt unter `/Users/zek/Documents/ChatGPT/Traumpfad/.cache/map-tiles/`; Worktrees ermitteln denselben Ordner über das gemeinsame Git-Verzeichnis. Für andere Installationen wird entsprechend das Hauptprojekt verwendet. `TRAUMPFAD_TILE_CACHE_DIR` kann einen anderen Ordner vorgeben. Bilddateien und SQLite-Index bleiben außerhalb von Git. Node 24 wird für `node:sqlite` benötigt.

**Route vorbereiten: Umfang berechnen** erzeugt zunächst nur einen Plan aus der vollständigen GPX-Datei: 20 km auf jeder Routenseite, Zoom 0–14, überlappende Gebiete dedupliziert. Um Lücken zwischen GPX-Punkten zu vermeiden, enthält die geometrische Abdeckung einen konservativen Rand von etwa 500 Metern. Aktuell ergeben sich 8.507 Kachelkoordinaten je Quelle, insgesamt 17.014 Bilder. Die Schätzung setzt die Bildvarianten voraus, die beim normalen Laden der Satellitenkarte tatsächlich beobachtet wurden. Deshalb zuerst Satellitenkarte und Gelände öffnen. Für die Planung werden keine Kartenbilder von Mapbox angefordert.

Der Vorabdownload bleibt ohne bestätigte kostenlose Restkontingente gesperrt. In den aufklappbaren Einstellungen sind die im Mapbox-Konto gerade geprüften Restkontingente für Satellitenbilder, Gelände und beide zusammen einzutragen. Bei geteilten API-Kontingenten darf die Gesamtmenge nicht doppelt gezählt werden. Die App kann diese Kontostände nicht selbst auslesen. 20 % bleiben als Reserve frei; andere Apps/Geräte müssen das Konto während des Downloads nicht zusätzlich nutzen. Jede tatsächlich gestartete Vorab-Anfrage, einschließlich Fehlern und Revalidierungen, verbraucht eine Budgeteinheit. Echte Kostenfreiheit setzt korrekte aktuelle Kontowerte voraus; die App kann fremde Kontonutzung nicht verhindern.

Direkte Raster-Vorabdownloads sind nicht mit dem Freikontingent von 50.000 GL-JS-Kartenstarts gleichzusetzen. Sie erhalten keine erfundenen SDK-Sitzungsparameter. Siehe [Mapbox Raster Tiles API](https://docs.mapbox.com/api/maps/raster-tiles/).

**Pausieren**, **Fortsetzen / fehlende Kacheln laden**, **Speicherstatus prüfen** und **Festplattencache leeren** steuern den Speicher. Die Statusabfrage liest nur lokale Metadaten. Ein Neustart setzt keinen Download automatisch fort; vor dem Fortsetzen sind die Restkontingente erneut zu bestätigen. HTTP 429 pausiert bis zum Ende der angegebenen Wartezeit, 401/403 stoppen mit einem Hinweis. Einträge ohne Anbieterabdeckung (404, etwa DEM über Wasser) werden als nicht verfügbar ausgewiesen und nicht gespeichert; eine neue Planung prüft diese erneut.

Das Limit beträgt 20 GB einschließlich Index und reserviertem Platz für temporäre Bilddateien. Bei Platzbedarf werden die am längsten nicht verwendeten Einträge gelöscht, unabhängig von ihrem Alter. Ist kein Platz verfügbar, kann die sichtbare Karte online weiterladen, ohne diese Bilder zu speichern; Vorabdownloads pausieren. Fehlerantworten, ungültige Bilddaten und `no-store` werden nicht als Bilder gespeichert. Die App prüft gespeicherte Bilder nicht mehr bei Mapbox auf Aktualität; sie können daher veraltet sein.

Dies ist **keine vollständige Offline-Karte**. Kartenstil, Schriften, Symbole, weitere Mapbox-Dienste sowie noch nicht gespeicherte oder nicht verfügbare Kacheln benötigen weiterhin Internet. Ohne bestätigtes Vorabkontingent bleibt die normale Wiederverwendung beim Erkunden und Abspielen verfügbar.

### Kamera beim Start

Beim Klick auf eine Etappe fliegt die Karte in etwa 2,6 Sekunden zu deren Ausgangspunkt. **Die Reise beginnen** und **▶** führen anschließend mit einem etwa 2,2 Sekunden langen Übergang aus der sichtbaren Kameraposition in die Vogelperspektive des Routenflugs. Während des Anflugs und beim Warten auf benötigte Höhendaten bleibt der Routenfortschritt stehen. Pause hält auch einen laufenden Anflug an; Fortsetzen beginnt aus der zuletzt sichtbaren Kameraposition. Schnelle Etappenwechsel verwerfen die vorherige Kamerabewegung. Die Systemeinstellung für reduzierte Bewegung wird berücksichtigt.

Neue Konten ohne Zahlungsmethode haben einen eingeschränkten Testzugang. Laut [Mapbox-Dokumentation](https://docs.mapbox.com/accounts/guides/signup/#limits) ist die Raster Tiles API für unsere Satellitenbilder dort nicht verfügbar, auch bei gültigem Schlüssel und bestätigter E-Mail-Adresse. Für diesen Zugriff muss in der [Mapbox-Konsole](https://console.mapbox.com/) eine Zahlungsmethode hinterlegt werden. Dabei gelten weiterhin monatliche Freikontingente; Nutzung darüber hinaus wird berechnet. Falls beim Wechsel der Token erneuert wird, muss auch der Schlüssel in der App ersetzt werden. Die App verändert keine Kontofreigaben oder Zahlungsdaten. HTTP 429 kann außerdem auf ein Anfragelimit hinweisen und beweist allein keine Kontosperre. Siehe auch [Demo-Zugriff bei Mapbox](https://docs.mapbox.com/accounts/guides/demo-access/).

## Stand der Inhalte

Enthalten sind die **GPX-Gesamtstrecke München–Venedig und alle 27 Tagesetappen** in vier Wochenkapiteln. Zehn Fotostopps und elf Bildplätze sind weiterhin ausdrücklich Beispiele. Es wurden keine eigenen Fotos, Reisedaten oder Erlebnisse erfunden. Die Tagesabschnitte folgen einem veröffentlichten Referenztrack und müssen noch mit deiner tatsächlich begangenen Linie abgeglichen werden.

Die 28-Tage-Variante ist für deine 27 Reisetage angepasst: Fedaia–Alleghe und Alleghe–Rifugio Tissi sind als eine Tagesetappe Fedaia–Rifugio Tissi zusammengefasst; eine Übernachtung in Alleghe ist nicht eingetragen. Der Linienverlauf dieser Etappe stammt weiterhin aus dem Referenztrack und ist keine bestätigte Aufzeichnung deiner direkten Variante. Die Etappe zum Rifugio 7° Alpini ist als Schiara-Überquerung mit Klettersteig markiert; auch deren Linie ist eine Referenz.

### GPX-Referenzroute

Die unveränderte Quelldatei liegt unter `app/data/routes/traumpfad-muenchen-venedig.gpx`, die für die Karte konvertierte Gesamtstrecke unter `app/data/routes/gesamtstrecke.geojson`. Download auch in **⚙ → Die GPX-Route**. Der Gesamtflug dauert bei einfacher Geschwindigkeit 20 Minuten; der Schieberegler erlaubt direkte Sprünge.

Quelle: [Fastest Known Time – Traumpfad München–Venedig](https://fastestknowntime.com/route/traumpfad-munchen-venedig-germany-austria-italy), Datei „traumpfad muenchen venedig -komplett-.gpx“. Ursprünglicher Autor laut GPX: Björn Mußmann – Outdooractive Community, [Originaltour 104193538](https://www.outdooractive.com/r/104193538), Stand 23.08.2018, heruntergeladen am 25.10.2026. 35.524 Punkte einschließlich Höhenangaben, ca. 545 km. Es ist ein veröffentlichter Referenztrack mit Varianten und Fährüberfahrt, keine persönliche Aufzeichnung und keine Zusicherung aktueller Begehbarkeit.

Die 27 Tagesabschnitte sind aufeinanderfolgende Ausschnitte dieser Punktfolge. Ihre Grenzen wurden anhand der veröffentlichten 28-Tage-Abfolge und erkennbarer Etappenorte angenähert; die Tagesgrenzen sind nicht persönlich bestätigt. Die Linie ist deshalb ein Referenzverlauf und keine metergenaue Aufzeichnung deiner Wanderung. Der siebte Abschnitt endet in Wattens: Die veröffentlichte Variante passiert Hall nicht direkt; eine erfundene Verbindung nach Hall wurde vermieden. Die ursprünglichen schematischen Dateien sind unter `.cache/routes-before-gpx/` gesichert.

Die Punktabstände wurden geprüft. Der größte Abstand beträgt rund 1,36 km nahe Sottoguda (11.905360 / 46.441406 bis 11.906199 / 46.429194); dieser Teil ist im Original nur grob beschrieben und wird unverändert übernommen. Die Linie wird dort nicht als metergenauer Weg ausgegeben. Die Fährstrecke nach Venedig bleibt Bestandteil der Quelle. Fotostopps bleiben ausdrücklich Beispiele an ungefähren Positionen.

Ein zweiter geprüfter Download vom [GPS Wanderatlas](https://www.ich-geh-wandern.de/traumpfad-muenchen-venedig) war mit 4.988 Punkten und mehreren Abständen über zwei Kilometer gröber und wurde nicht eingebaut. Die [Rother-GPX-Dateien](https://gps.rother.de/download/muenchen-venedig-06-auflage/) benötigen das Passwort aus dem Wanderführer und beschreiben teils andere Varianten.

## Bedienung

| Aktion | Bedienung |
| --- | --- |
| Reise starten | „Die Reise beginnen“ |
| Flug starten / pausieren | Play-Schaltfläche oder Leertaste |
| Nächster / vorheriger Fotostopp | Pfeil rechts / links |
| Fotostopp fortsetzen | ▶, „Weiter auf dem Weg“ oder Leertaste |
| Bilder innerhalb eines Fotostopps | Bildpfeile oder Pfeil rechts / links; jeweils ein großes Bild |
| Fotostopp ausblenden und pausiert bleiben | „Fotos ausblenden“ oder `Escape` |
| Tagesgalerie | „Tagesgalerie öffnen“ oder `G` |
| Dialog schließen | Kreuz oder `Escape` |
| Vollbild | Schaltfläche oben rechts oder `F` |
| Etappe überspringen | Etappe links auswählen |
| Frei navigieren | Ziehen pausiert und wechselt ins Erkunden. Zoomen läuft während des Flugs weiter; „Präsentieren“ kehrt zum gespeicherten Stand zurück |
| Karte zoomen | Mausrad / Trackpad scrollen oder Doppelklick; Umschalt + Doppelklick zoomt heraus |
| Kamerahöhe ändern | Shift halten und mit linker oder rechter Maustaste hoch/runter ziehen. Der Flug läuft weiter. |
| Karte verschieben | Linke Maustaste halten und ziehen |
| Während des Flugs umsehen | Rechte Maustaste halten und ziehen: links/rechts dreht den Blick, hoch/runter neigt ihn. Der Flug folgt weiter der Route. |

Die Maussteuerung gilt für die verbundene Mapbox-Karte. Verschieben mit der linken Maustaste pausiert den Flug und wechselt ins Erkunden. Die Bewegung ist auf 15 Prozent gedämpft und bei großer Höhe auf 30 Meter pro Pixel begrenzt. Drehung, Kamerahöhe und Zoom reagieren ebenfalls langsamer; Mausrad und Trackpad zoomen in kleineren Schritten, ebenso Doppelklick und die +/−-Schaltflächen. Zoomen verändert den Kameraabstand, ohne den Flug zu unterbrechen. Die rechte Maustaste (am Mac auch Ctrl + linke Maustaste) steuert die Blickrichtung: Während der Präsentation folgt die Kameraposition weiter der Route, die Wiedergabe läuft weiter. Die Blickrichtung bleibt relativ zur Route erhalten, auch in Kurven. „Präsentieren“ führt die Kamera zum gespeicherten Stand zurück; ▶ setzt den Flug fort. Automatische Kamerafahrten lösen diesen Wechsel nicht aus.
An Fotostopps und am Ende einer Etappe pausiert der Flug. Kleine Fotovorschauen schweben an den Fotostopps über der Karte. Nach dem Anflug wächst ein geladenes und dekodiertes Bild aus seiner Vorschau zur großen Ansicht (4800 ms), während die Kamera zunächst auf Detailzoom 19 und anschließend bis ungefähr 10 Meter über das geladene Gelände zufliegt. Fehlen Höhendaten, bleibt sie beim sicheren Mapbox-Anflug. Mit „Weiter auf dem Weg“, ▶ oder Leertaste schrumpft es zur Vorschau zurück (650 ms), die Kamera kehrt zur vorherigen Perspektive zurück und der Flug geht weiter. Weitere Bilder werden einzeln durchgeblättert. Die Einstellung für reduzierte Bewegung wird berücksichtigt. Die Tagesgalerie verwendet weiterhin ihre eigene Bildansicht. Nach dem letzten Tag startet Play die Reise erneut. Beim Wechsel in einen anderen Browser-Tab wird der Flug pausiert. Im Vollbild bleiben die Quellenangaben sichtbar. Auf schmalen Bildschirmen steht die Etappenliste unter der Karte.

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

### Bilder, Videos und Fotopunkte im Browser bearbeiten

Starte die App mit `npm start` und klicke oben auf **Bearbeiten**. Wähle eine Etappe und einen vorhandenen Fotopunkt oder setze einen neuen Punkt auf der Karte. Zum Verschieben wählst du einen Fotopunkt und klickst auf **Ausgewählten Punkt auf Karte verschieben**; anschließend klickst du auf die gewünschte Stelle an der Route. Das funktioniert auch in der schematischen Vorschau.

Über **Bilder oder Videos hinzufügen** kannst du mehrere Dateien auf einmal an den ausgewählten Fotopunkt hängen. Sie erscheinen dort der Reihe nach und zusätzlich in der Tagesgalerie. JPEG, PNG, WebP, AVIF, GIF sowie MP4, WebM und MOV bis 200 MB pro Datei werden unterstützt. Eine Collage kannst du als Bilddatei hochladen. Mit **Änderungen speichern** bleiben die Inhalte in `app/data/journey.json` und `app/assets/photos/` auf diesem Mac. Es gibt keine Übertragung an einen externen Dienst.

Für viele Originalfotos mit automatischer Tageszuordnung bleibt der unten beschriebene Import über `Material/fotos-originale/` verfügbar.

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

Mit **Zentrieren** neben der Fluggeschwindigkeit kehrt die Kamera zur aktuellen Routenposition und zur normalen Flugansicht zurück. Verschiebung, Blickrichtung, Zoom und Höhenänderung werden zurückgesetzt. Die aktuelle Stelle bleibt erhalten; pausierte Wiedergabe bleibt pausiert.
