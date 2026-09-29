# Changelog

## [1.2.2](https://github.com/twostone/ha-meal-planner/compare/v1.2.1...v1.2.2) (2026-09-29)


### Bug Fixes

* Karte als Lovelace-Resource registrieren, damit die Companion App sie zuverlässig lädt ([#14](https://github.com/twostone/ha-meal-planner/issues/14)) ([d8ad35b](https://github.com/twostone/ha-meal-planner/commit/d8ad35b86579cde8729b82583b4a8f4dfee00471))

## [1.2.1](https://github.com/twostone/ha-meal-planner/compare/v1.2.0...v1.2.1) (2026-09-29)


### Bug Fixes

* Sidebar-Pfad /&lt;slug&gt; statt /hassio/ingress/&lt;slug&gt; ([#12](https://github.com/twostone/ha-meal-planner/issues/12)) ([59cda32](https://github.com/twostone/ha-meal-planner/commit/59cda327891144eee0c45e5f83ff43b68c307f28))

## [1.2.0](https://github.com/twostone/ha-meal-planner/compare/v1.1.0...v1.2.0) (2026-09-29)


### Features

* Link zur App-Oberfläche in Karte und Gerät ([#11](https://github.com/twostone/ha-meal-planner/issues/11)) ([8f94683](https://github.com/twostone/ha-meal-planner/commit/8f946838e224adc283279311e68b287ba9c2f73a))


### Bug Fixes

* Karte zeigt echte Daten statt Demo, wenn die Entität existiert ([#9](https://github.com/twostone/ha-meal-planner/issues/9)) ([e1d06b2](https://github.com/twostone/ha-meal-planner/commit/e1d06b21d2fa909eec67ec36abd0df1351ecfb54))

## [1.1.0](https://github.com/twostone/ha-meal-planner/compare/v1.0.0...v1.1.0) (2026-09-29)


### Features

* visueller Editor und Picker-Vorschau für die Karte ([#6](https://github.com/twostone/ha-meal-planner/issues/6)) ([56220f1](https://github.com/twostone/ha-meal-planner/commit/56220f13676c230a14b49ba2f7927324ff725f6e))

## [1.0.0](https://github.com/twostone/ha-meal-planner/compare/v0.2.0...v1.0.0) (2026-09-29)


### ⚠ BREAKING CHANGES

* Der Webhook entfällt, bestehende Einträge müssen neu eingerichtet werden. Braucht die Version der Meal-Planner-App mit Discovery und zweitem Port. Mindestversion Home Assistant 2024.11.

### Features

* Abruf per Coordinator, Einrichtung per Discovery, Logbuch, nächste Liste ([#3](https://github.com/twostone/ha-meal-planner/issues/3)) ([d223f3d](https://github.com/twostone/ha-meal-planner/commit/d223f3d554fe5ffac2f94767ae0d5cb62393615d))
* flaches Icon für die Integration ([#2](https://github.com/twostone/ha-meal-planner/issues/2)) ([0acd7d8](https://github.com/twostone/ha-meal-planner/commit/0acd7d8d9f9ae36ffe5d25e97348f62a1c608562))
* Meal-Planner-Integration mit Webhook, Sensoren und Lovelace-Karte ([592a424](https://github.com/twostone/ha-meal-planner/commit/592a424288ddbb3da875a8586c8d667b86e395c2))


### Bug Fixes

* CI-Fehler beheben (hassfest, hacs, pytest) ([a82fe77](https://github.com/twostone/ha-meal-planner/commit/a82fe779d81a44406c1398442812feec9dbed459))
* **ci:** manifest.json-Schlüssel alphabetisch sortieren (hassfest) ([ef06f75](https://github.com/twostone/ha-meal-planner/commit/ef06f7551783f5b11fee19a8c6ef1f96df2181a8))
