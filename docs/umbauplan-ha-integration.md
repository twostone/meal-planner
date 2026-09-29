# Umbauplan: App (meal-planner) und Custom Component (ha-meal-planner)

_Stand: 29.09.2026. Grundlage: gelesener Code von `twostone/meal-planner` (v0.6.0: `AGENTS.md`, `config.yaml`, `src/ha-notify.ts`, `src/app.ts`, `src/repo.ts`) und `twostone/ha-meal-planner` (v0.1.0: `__init__.py`, `config_flow.py`, `sensor.py`, `const.py`, `manifest.json`, `www/meal-planner-card.js`, `AGENTS.md`)._

## 1. Entscheidungen (vom Nutzer)

- Die Component **ruft** die App über einen eigenen Port mit Token **ab** (statt bisher Webhook-Push).
- Die Übergabe von Host, Port und Token erfolgt per **Supervisor-Discovery**, mit manuellem Fallback.
- „Aktuelle“ und „nächste“ Liste werden über das heutige Datum bestimmt.
- Events für Automationen **und** Logbuch.
- **Jedes Event enthält den auslösenden HA-Nutzer** (`user: {id, name, display_name}`).

## 2. Ist-Zustand

Die Integration ist heute push-only (`iot_class: local_push`): Die App POSTet nach jeder Änderung der aktuellen Liste und beim Start einen Snapshot an einen Webhook (`ha_webhook_url`, vom Nutzer aus dem Config Flow kopiert). Nur `plan_created` und `entry_added` tragen ein Event. Drei Sensoren, zwei Bus-Events, eine reine Anzeige-Karte. Es gibt keinen Rückkanal. Beide `AGENTS.md` halten fest: kein Polling, keine REST-Abfrage der App, keine neuen Ports ohne Rückfrage. Der Umbau kehrt diese Entscheidungen bewusst um, die Dateien müssen deshalb mit angepasst werden. Beide Seiten sind laut `AGENTS.md` nie gegen eine echte HA-Instanz gelaufen.

## 3. Ziel-Architektur

- **Daten (Component → App):** Zweiter Listener der App, nur `GET /ha/state`, Bearer-Token. Antwort: `{current, next, generated_at}`. Die Component nutzt einen `DataUpdateCoordinator` mit Fallback-Intervall (5 Minuten). Weil die App „aktuell/nächste“ bei jeder Abfrage neu über das Datum bestimmt, ist der Datumswechsel um Mitternacht damit erledigt, ebenso der Zustand nach einem HA-Neustart (der Coordinator lädt beim Setup).
- **Events (App → HA):** Die App setzt `homeassistant_api: true` und ruft `POST http://supervisor/core/api/events/<typ>` mit `SUPERVISOR_TOKEN` auf (Endpunkt in der REST-Doku belegt). Die Component hört auf diese Events, feuert nichts selbst und stößt beim Eintreffen sofort einen Coordinator-Refresh an.
- **Einrichtung (App → HA):** `discovery: [meal_planner]` in der `config.yaml`. Beim Start postet die App `{service: "meal_planner", config: {host, port, token}}` an `http://supervisor/discovery`. Die Integration bekommt das in `async_step_hassio`, der Nutzer bestätigt nur. Der Webhook entfällt komplett.
- **Ingress bleibt unberührt:** Port 8099 mit `INGRESS_ONLY_IP`-Guard, Frontend und alle bestehenden Routen. Der neue Listener ist eine eigene, minimale Hono-App mit genau einer Route.

## 4. Lücken gegenüber den Anforderungen

| Anforderung | Heute | Aufgabe |
|---|---|---|
| Offene Gerichte der Woche | vorhanden | bleibt |
| Geplant/gekocht | vorhanden | bleibt |
| Aktuelle Liste | vorhanden, aber nur bei Push aktuell | Coordinator |
| Nächste Liste | fehlt | App, Sensor, Karte |
| Event Liste angelegt / Gericht hinzugefügt | vorhanden, dünner Payload | neuer Payload |
| Event Gericht entfernt / abgehakt | fehlt | App und Component |
| Logbuch | fehlt | Component |

## 5. Plan

### Phase 0 – Unverifiziertes klären (vor dem Bauen, am echten System oder gegen Doku/Code)
1. Darf die App ohne `hassio_api` an `POST /discovery` posten? (Supervisor-Code prüft nur, dass der Service unter `discovery:` deklariert ist; nicht am System bestätigt.) Woher bekommt die App ihren Hostnamen (`GET /addons/self/info`, Feld `hostname`; laut Doku ohne `hassio_api` erreichbar)?
2. Erreicht die Component (im Core-Container) den zweiten Port der App über dieses Hostname:Port, ohne dass ein `ports:`-Mapping nötig ist?
3. Kommt `POST /core/api/events/<typ>` über den Supervisor-Proxy in HA an, und sieht die Component das Event auf dem Bus?
4. Wird `async_step_hassio` für eine Custom Component tatsächlich aufgerufen, und wie verhält sich `_abort_if_unique_id_configured(updates=...)` bei geänderter Config (Reload)? Der Discovery-Dienstname (`meal_planner`) muss der Integrations-Domain entsprechen (in `manifest.json` und `const.py` bereits der Fall, Flow-Handler wird nach `service` gewählt).
5. **Nutzer-Header:** Liefert der Ingress `X-Remote-User-*` am echten System, auch aus der Companion-App? (Der Supervisor-Code setzt sie bei bekannter Session, die Doku-Seite „Presenting your app“ erwähnt sie nicht, und die App-`AGENTS.md` hält fest, dass es am echten System ungeprüft ist.) Zusätzlich: Welchen Nutzer trägt der Kontext eines per REST gefeuerten Events? Vermutlich den Supervisor-Systemnutzer, nicht den Menschen, weshalb der Nutzer im Payload steht. Das ist nicht geprüft.
6. Logbuch: `logbook.log`-Aktion (in der HA-Doku als „Log activity“ dokumentiert, Parameter prüfen) oder `logbook.py` mit `async_describe_events` (in der Entwickler-Doku nicht gefunden, nur aus dem Kopf bekannt). Empfehlung: `logbook.py` mit `async_describe_events` (übliche Methode für eigene Events, behält den Nutzerkontext, kein Aktionsaufruf nötig), in der Entwickler-Doku gegenprüfen.
7. **Zeitzone:** Bestimmt die App „heute“ in der Zeitzone von Home Assistant? Add-on-Container laufen womöglich in UTC, dann wechselt die Liste zur falschen Stunde. Prüfen, ob `TZ` im Container gesetzt ist, sonst Zeitzone vom Supervisor holen.

#### Phase 0: Ergebnisse (29.09.2026, nur aus Supervisor-/Core-Quelltext gelesen, nichts am System getestet)

| Punkt | Ergebnis | Status |
|---|---|---|
| 1 Discovery ohne `hassio_api` | `POST /discovery` und `/addons/self/info` laufen laut `security.py` an der Rollenprüfung vorbei; `discovery.py` prüft nur, dass der Dienst unter `discovery:` deklariert ist (sonst 403). Antwort: `{uuid}`. Nachrichten mit gleichem Inhalt werden dedupliziert, geänderte Config aktualisiert die vorhandene Nachricht. Gespeichert wird in einer Datei (Klartext wird nicht bestritten, Token also dort lesbar). | gelesen, nicht getestet |
| 1b Hostname | `hostname` aus `/addons/self/info` nicht direkt im Code gesehen (Quelle nicht abrufbar). | offen |
| 2 Zweiter Port erreichbar | nicht am Code zu klären. | offen, System nötig |
| 3 `POST /core/api/events/<typ>` | Proxy verlangt `homeassistant_api` (Rolle `homeassistant`), leitet Pfade generisch weiter, sperrt nur `hassio`-Pfade. Events werden nicht gesondert behandelt. Ob die Rolle allein aus dem Flag folgt, nicht direkt gesehen. | plausibel, nicht getestet |
| 4 `async_step_hassio` in Custom Component | Core startet den Flow mit `discovery_flow.async_create_flow(domain=data.service, source=hassio)`, ohne Prüfung auf eingebaute Integrationen. Übergeben: `config`, `name`, `slug`, `uuid`. Der Dienstname muss der Domain entsprechen (`meal_planner` passt). Reload-Verhalten von `updates=` nicht geprüft. | Kernpunkt bestätigt |
| 5 Nutzer-Header | nicht am Code zu klären. | offen, System nötig |
| 6 Logbuch | `logbook.py` mit `async_describe_events(hass, async_describe_event)` und `async_describe_event(domain, event_type, callback)`; der Callback liefert ein Dict mit `name`, `message`, optional `icon`, `entity_id`, `context_id` (Beispiel: `homeassistant/logbook.py`). Für Custom Components nicht gesondert dokumentiert gefunden. | Empfehlung `logbook.py` hält |
| 7 Zeitzone | Der Supervisor kennt `TZ`; Add-ons können sie beziehen (laut Community-Quellen, nicht im Supervisor-Code gesehen). Ob `TZ` im Container gesetzt ist, ist offen. | offen, im Container prüfen (`echo $TZ`) |

**Am echten System bleiben:** 1b, 2, 3 (Ende-zu-Ende), 5, 7 und das Reload-Verhalten aus 4. Das lässt sich kompakt mit einer Wegwerf-App-Version prüfen (Discovery posten, Event feuern, `echo $TZ`, Header loggen).

### Phase 1 – App (Branch `feat/ha-abruf`, Repo meal-planner)
1. **Zweiter Listener** (z. B. Port 8100) mit separater Hono-App: nur `GET /ha/state`. Token beim ersten Start zufällig erzeugen und in `/data` ablegen, Vergleich zeitkonstant (`timingSafeEqual`), alles andere 404, kein Vertrauen in `X-Remote-User-*`. Tests: 401 ohne/mit falschem Token, 200 mit Token, der Ingress-Port lehnt Fremde weiterhin ab, keine Route außer `/ha/state`.
2. **`getNextPlan()`** in `repo.ts` neben `getCurrentPlan()` (`repo.ts:206`). Regel: *aktuell* = Liste, die heute enthält, in einer Lücke `null`; *nächste* = früheste Liste mit Startdatum nach heute. Tests inkl. Lücke. `snapshot()` in `ha-notify.ts` von `getCurrentPlan()` lösen und auf `snapshot(plan)` verallgemeinern; `GET /ha/state` nutzt es für `current` und `next` (Form `HaPlan` mit `entries` bleibt, die Karte konsumiert sie).
3. **Events:** `ha-notify.ts` ersetzen: `POST http://supervisor/core/api/events/meal_planner_<typ>` mit Bearer `SUPERVISOR_TOKEN`. Typen: `plan_created`, `entry_added`, `entry_removed`, `entry_done`, `entry_undone`. Daten: `plan_id`, `start_date`, `end_date`, `entry: {id, dish_id, title}` und `user: {id, name, display_name} | null`. Ausgelöst in den Routen für Liste anlegen, Eintrag anlegen, Eintrag löschen und Eintrag ändern (nur wenn sich `done` ändert). Fire-and-forget mit Kette wie bisher, Fehler nur loggen. Weiterhin plain `fetch` (Ziel ist der Supervisor, kein Nutzer-Input); den Kommentar in `ha-notify.ts` von „Webhook aus den Optionen“ auf „Supervisor“ umschreiben. Ein Event trägt keinen Snapshot mehr: Automationen lesen Details aus den Eventdaten, nicht aus Sensorattributen, die einen Moment hinterherhinken können (im README vermerken).
   - **Nutzer:** Die Header `X-Remote-User-Id`, `-Name` und `-Display-Name` liest `app.ts` schon in `/api/me`. Die Leselogik wird zu einem Helfer (`haUser(c)`) herausgezogen, den `/api/me` und alle Mutations-Routen teilen. Er wird als Argument an den Notifier übergeben (`notifyHa({type, plan, entry, user})` statt `notifyHa("entry_added")`). Alle Felder sind nullable: laut Supervisor-Code (`_init_header`) setzt der Ingress die ID nur bei bekannter Session, Name und Anzeigename nur, wenn sie am HA-Nutzer gesetzt sind.
   - **Vorher-Zustand:** Für `entry_removed` (Titel) und `entry_done`/`entry_undone` (Änderung von `done`) muss die Route den Eintrag *vor* der Änderung kennen. Dafür in `repo.ts` den Eintrag vor `deleteEntry`/`updateEntry` lesen oder die Rückgabe erweitern, mit Tests.
   - **Nur Ingress-Anfragen:** Die Header sind nur vertrauenswürdig, weil der Guard nur `172.30.32.2` durchlässt. Der neue Token-Listener ist read-only und hat keinen Nutzer, dort werden weder Header gelesen noch Events ausgelöst.
4. **Discovery:** `discovery: [meal_planner]` und `homeassistant_api: true` in der `config.yaml`. Beim Start `POST /discovery` mit Retry und Backoff (Core kann noch starten), Fehler nie fatal. Config: `{host, port, token}`.
5. **Aufräumen:** Option `ha_webhook_url` und Schema entfernen (Breaking, `feat!:`; `options: {}`/`schema: {}` gegen CI-Lint prüfen). Token-Rotation: Datei in `/data` löschen und App neu starten, im README festhalten. `AGENTS.md`: Abschnitt „Home-Assistant-Push“, „Sicherheit“ (neuer Port ist jetzt freigegeben, Regel anpassen) und „Bewusst nicht gebaut“ umschreiben.
6. PR-Titel `feat!(ha): …`, CI grün, Docker-Smoke-Test um den zweiten Port erweitern.

### Phase 2 – Component (Repo ha-meal-planner)
1. **Config Flow:** Der bisherige Single-Instance-Abbruch (`_async_current_entries()`) gilt für alle Wege (Discovery und manuell), sonst entstehen zwei Einträge; der manuelle Weg braucht eine eigene `unique_id` (host:port). `async_step_hassio` (Bestätigung, `unique_id` = Discovery-UUID, damit der Eintrag bei Deinstallation der App automatisch entfernt wird; bei erneutem Discovery `updates={host, port, token}`). Fallback-Schritt `user` mit Host, Port, Token und Verbindungstest. Reauth-Schritt für ein geändertes Token.
2. **Coordinator** (`coordinator.py`): `GET /ha/state` mit `async_get_clientsession`, Timeout, Bearer-Token, `UpdateFailed` bei Fehlern (Entitäten werden dann „nicht verfügbar“). Intervall 5 Minuten. Listener auf die fünf Bus-Events löst `async_request_refresh` aus.
3. **Sensoren:** auf `CoordinatorEntity` umstellen (`unique_id`-Schema `{entry_id}_{key}` beibehalten; das Flag `_card_registered` in `hass.data[DOMAIN]` liegt neben den Einträgen, Entladen darf nicht davon ausgehen, dass jeder Schlüssel eine `entry_id` ist; „Nächste Liste“ mit derselben Attributform wie „Aktuelle Liste“, damit die Karte sie wiederverwendet), neuer Sensor „Nächste Liste“, bei `entries` `_unrecorded_attributes` setzen (in der Doku als `frozenset[str]` beschrieben).
4. **Logbuch** gemäß Phase 0, Punkt 6. Die Meldung nennt den Nutzer („Anna hat Pasta hinzugefügt“), bei fehlendem Anzeigenamen Rückfall auf den Benutzernamen, sonst „Jemand“. Für Automationen steht der Nutzer unter `trigger.event.data.user` (`id` ist die HA-Nutzer-ID, z. B. zum Abgleich mit Personen).
5. **Karte:** Abschnitt „Nächste Liste“ mit Konfigurationsschlüssel `next_entity`, `VERSION` anheben.
6. **Manifest/Aufräumen:** `iot_class` auf `local_polling`, Abhängigkeit `webhook` entfernen (`http` bleibt für die Karten-Auslieferung), Webhook-Code aus `__init__.py` entfernen. Bestehende Einträge mit `webhook_id`: da nie am echten System betrieben, ohne Migration ersetzen (YAGNI), im Changelog vermerken. `AGENTS.md` anpassen, Tests neu schreiben (Coordinator, Discovery-Flow, Fallback-Flow, Events, Sensoren).

### Phase 3 – Abnahme am echten System
1. App-Release (Release Please) abwarten, Image auf ghcr prüfen, App aktualisieren.
2. Integration installieren, Discovery-Karte bestätigen.
3. Prüfen: aktuelle und nächste Liste, alle fünf Events auf dem Bus und im Logbuch, Datumswechsel, HA-Neustart, App gestoppt (Sensoren nicht verfügbar) und wieder gestartet.

## 6. Risiken und Nachteile der gewählten Variante

- **Zwei Kanäle statt einem:** Daten per Abruf, Events per REST. Ist HA beim Event nicht erreichbar, geht das Event verloren (der Zustand wird beim nächsten Abruf nachgeholt, das Event nicht).
- **Neue Angriffsfläche:** ein zusätzlicher Port. Das Token liegt in der App unter `/data` und über die Discovery beim Supervisor; ob die Discovery-Datei im Klartext liegt, ist nicht geprüft. Der Port sollte nur Lesezugriff auf einen kleinen Zustand bieten.
- **Nutzerangabe ist nur so verlässlich wie der Ingress-Guard:** Die Header wären fälschbar, wenn der Guard je gelockert wird. Die Liste bleibt gemeinsam, der Nutzer ist reine Information im Event und keine Berechtigung.
- **Abhängigkeit von der App:** Ist die App gestoppt, sind die Sensoren nicht verfügbar. Das ist ehrlicher als der alte Stand, kann aber Automationen beeinflussen.
- **Mehr Bewegliches als der Bestand:** Discovery, Token, Coordinator und Events sind vier Mechanismen. Verlorene Events werden nicht nachgeholt; für eine Haushaltsliste reicht Loggen und Verwerfen. Der Push-Weg hätte laut Analyse alle Anforderungen mit einer Payload-Erweiterung und einem Heartbeat ebenfalls erfüllt (für die Entscheidung: nicht gewählt, hier nur dokumentiert).

## 7. Offene Punkte

- Ergebnisse aus Phase 0 (sechs Punkte).
- Zeitzone der App (Phase 0, Punkt 7).
- Port-Nummer und Fallback-Intervall (Vorschläge: 8100, 5 Minuten).
- Logbuch: Empfehlung `logbook.py`, in Phase 0 bestätigen.
- Die Karte wurde gelesen, aber nicht im Browser gestartet. Offene PRs in ha-meal-planner (#1 Actions-Bump, #2 Icon) bleiben unberührt.
