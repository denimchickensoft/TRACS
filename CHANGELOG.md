# Changelog

All notable changes to TRACS and the TRACS Relay are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). TRACS releases are tagged `vX.Y.Z` and relay releases `relay-vX.Y.Z`.

## [Unreleased]

### Added
- About section in Settings, with copyright, license, data attributions and a link to the third-party notices.
- `THIRD_PARTY_NOTICES.md`, crediting OpenStreetMap, Natural Earth, the terrain data providers, DCS World, DCS Olympus, pydcs and the brevity manual.
- LittleNavMap database setup dialog, plus **Settings → Navigation data → Change…**. Fix and procedure commands reply `NO NAVDATA` when no database is configured.
- README "Known limitations" section.
- Contributing guide, security policy, code of conduct, and issue and pull-request templates.

### Changed
- TRACS releases are now tagged `vX.Y.Z` (previously `tracs-vX.Y.Z`) and publish directly rather than as drafts. Relay releases are never marked as the repository's latest release.
- The local server listens only on this machine by default; set `TRACS_HOST` to opt in to LAN access.
- External links open in your normal browser instead of inside TRACS.
- Operator-edited config files are never overwritten by an update; only newly added settings are merged in.
- The desktop installer ships only runtime files, and bundled theatre data is no longer copied into your user folder.
- Builds use Node.js 22.

### Removed
- The STARS obstruction (OBST) layer and its data.

### Fixed
- Changes made in pop-out windows now reach other controllers.
- A DCS mission restart no longer stops the Tacview source with a false "wrong password" error.
- The relay no longer crashes on malformed SRS packets or sync messages, and its self-updater now reads its own version and verifies downloads.
- STARS SAVE AS now saves every map layer.
- Controllers joining a CATCC session late now receive ceiling, visibility and altimeter.
- ABM Drawings now honors the `.be` bullseye override.
- Flight-plan CIDs no longer collide after a page reload or in pop-out windows.
- An invalid scan-rate setting can no longer pin a CPU core.
