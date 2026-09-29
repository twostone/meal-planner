# Changelog

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
