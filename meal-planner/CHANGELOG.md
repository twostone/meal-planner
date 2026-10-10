# Changelog

## [0.12.0](https://github.com/twostone/meal-planner/compare/v0.11.0...v0.12.0) (2026-10-10)


### Neu

* **katalog:** Gerichte nach Zutat suchen ([#37](https://github.com/twostone/meal-planner/issues/37)) ([a792a6b](https://github.com/twostone/meal-planner/commit/a792a6b2207fad9a32c6743b4c1b63fc062a74f8))
* **kochmodus:** mehrere Gerichte gleichzeitig kochen, Haken auf allen Handys ([#40](https://github.com/twostone/meal-planner/issues/40)) ([c45200d](https://github.com/twostone/meal-planner/commit/c45200dba8558231c4a95c46cd7680e275db1918))

## [0.11.0](https://github.com/twostone/meal-planner/compare/v0.10.1...v0.11.0) (2026-10-09)


### Neu

* **titel:** Titelvorschläge per KI ergänzen ([#28](https://github.com/twostone/meal-planner/issues/28)) ([1b298a9](https://github.com/twostone/meal-planner/commit/1b298a9c1d0b9e5f3f57925180a961aa8db54f59))

## [0.10.1](https://github.com/twostone/meal-planner/compare/v0.10.0...v0.10.1) (2026-10-09)


### Behoben

* **rezept:** Rezept aus Link holen auch bei leerem Rezept anbieten ([#26](https://github.com/twostone/meal-planner/issues/26)) ([867cd92](https://github.com/twostone/meal-planner/commit/867cd92ba3118bbaaa94314e719dfce734f00c62))

## [0.10.0](https://github.com/twostone/meal-planner/compare/v0.9.0...v0.10.0) (2026-10-09)


### Neu

* **rezept:** Zutaten per KI aus dem Originaltext erkennen ([#23](https://github.com/twostone/meal-planner/issues/23)) ([6ed27e8](https://github.com/twostone/meal-planner/commit/6ed27e84423fedbd203dc499193b16a1a2b988d8))

## [0.9.0](https://github.com/twostone/meal-planner/compare/v0.8.0...v0.9.0) (2026-10-09)


### Neu

* **rezept:** Originaltext aus dem Link sichern (Instagram-Caption, schema.org) ([#22](https://github.com/twostone/meal-planner/issues/22)) ([02c43a7](https://github.com/twostone/meal-planner/commit/02c43a7e3026ce60ac0cc27891b8d50e94e7d6d1))
* **rezept:** Rezept mit Zutaten und Zubereitung von Hand erfassen ([#20](https://github.com/twostone/meal-planner/issues/20)) ([7c1a57c](https://github.com/twostone/meal-planner/commit/7c1a57c21d6e148fcb1167fc40688c4173918ce9))

## [0.8.0](https://github.com/twostone/meal-planner/compare/v0.7.0...v0.8.0) (2026-10-02)


### Neu

* **ha:** Namen der Liste im HA-Zustand ausliefern ([ea960c6](https://github.com/twostone/meal-planner/commit/ea960c6e63788e80c188b470229d8f188c781b8b))
* **liste:** Name und Zeitraum einer Liste speichern (Migration v5, updatePlan) ([666a4c5](https://github.com/twostone/meal-planner/commit/666a4c55dc0af8963d81dceb6783bbae36db3efe))
* **liste:** Name und Zeitraum im Zeitraum-Blatt bearbeiten ([97cb8ec](https://github.com/twostone/meal-planner/commit/97cb8ec4f449fc31470f841f63d2d57fd4d979a0))
* **liste:** PATCH /api/plans/:id mit Überlappungsprüfung und Event plan_updated ([260e551](https://github.com/twostone/meal-planner/commit/260e551b93db0dd0e812416133845dfac31d0964))
* **liste:** Überlappungsprüfung beim Anlegen einer Liste ([c302a16](https://github.com/twostone/meal-planner/commit/c302a1618bb91c82892b6877dc26692e03f68333))

## [0.7.0](https://github.com/twostone/meal-planner/compare/v0.6.0...v0.7.0) (2026-09-29)


### ⚠ BREAKING CHANGES

* **ha:** Die Option ha_webhook_url entfällt. Die Integration muss auf die Version mit Discovery und Abruf umgestellt werden.

### Neu

* **app:** Favicon aus dem App-Icon einbauen ([ed51fb1](https://github.com/twostone/meal-planner/commit/ed51fb1d3254add8266e6181677a1d6c1aa56c70))
* **app:** icon.png für den Add-on-Store ergänzen ([804edff](https://github.com/twostone/meal-planner/commit/804edffd4c91f6f3514cbb18ef01779b2fccaf03))
* **ha:** Abruf per Token-Port, Events über den Supervisor, Discovery ([de69b67](https://github.com/twostone/meal-planner/commit/de69b67eb66abed58d98dad449f43345badf5ef2))

## [0.6.0](https://github.com/twostone/meal-planner/compare/v0.5.1...v0.6.0) (2026-09-28)


### Neu

* **ha:** Add-on pusht aktuelle Liste per Webhook an Home Assistant ([e81cdc5](https://github.com/twostone/meal-planner/commit/e81cdc506c7160194add1fbe2c41154a3a661fcc))
* **vorschau:** mehrere Titel-Vorschläge aus Link-Captions ([#10](https://github.com/twostone/meal-planner/issues/10)) ([4da551c](https://github.com/twostone/meal-planner/commit/4da551c407b3efe92dd08a54885f9d79ec37d084))

## [0.5.1](https://github.com/twostone/meal-planner/compare/v0.5.0...v0.5.1) (2026-09-26)


### Behoben

* **liste:** Zeilen entlasten, Listen-Notiz im Bearbeiten-Blatt ([#9](https://github.com/twostone/meal-planner/issues/9)) ([ab9698c](https://github.com/twostone/meal-planner/commit/ab9698c6a5614c4cc7eacf4510605db0aaa1053f))
* **ui:** Zurück-Taste schließt ein offenes Blatt statt die App zu verlassen ([732bdba](https://github.com/twostone/meal-planner/commit/732bdba291a1a56a6d7e9ce19c1776f0efbd8f91))

## [0.5.0](https://github.com/twostone/meal-planner/compare/v0.4.0...v0.5.0) (2026-09-25)


### Neu

* **liste:** Notiz pro Eintrag, die nur für diese Liste gilt (Backend) ([cacbc7a](https://github.com/twostone/meal-planner/commit/cacbc7a9b2591ffe68fb83d44b9487c6290b9a71))
* **liste:** Notiz-Button und Notiz-Blatt in der Liste, Notiz unter dem Titel ([c4af397](https://github.com/twostone/meal-planner/commit/c4af3970dc1422653ce010ee44cd9d6889c66eb7))

## [0.4.0](https://github.com/twostone/meal-planner/compare/v0.3.0...v0.4.0) (2026-09-25)


### Neu

* **kategorien:** Gerichte frei kategorisieren, im Katalog nach Kategorie filtern ([e955f89](https://github.com/twostone/meal-planner/commit/e955f8951559eb6d49e05c9c62afc2f1e907fc16))

## [0.3.0](https://github.com/twostone/meal-planner/compare/v0.2.1...v0.3.0) (2026-09-25)


### Neu

* **config:** set image ([1ed33ae](https://github.com/twostone/meal-planner/commit/1ed33aef62e71f495847f7187ed6374ea7ce7731))

## [0.2.1](https://github.com/twostone/meal-planner/compare/v0.2.0...v0.2.1) (2026-09-25)


### Performance

* **docker:** mehrstufiges Dockerfile, Frontend-Build nur einmal pro Architektur-unabhängigem Lauf ([c7800c2](https://github.com/twostone/meal-planner/commit/c7800c289e689c3509b76fe591a2332043289b25))
