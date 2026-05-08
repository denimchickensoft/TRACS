# TRACS — TODO

Organized by area. Items marked `[spec]` have a written spec in `/resources/specs/`.

---

## WebRTC

- [ ] CONTROLLER_MESSAGE UI — compose and display cross-position messages (infrastructure done, no UI)
- [ ] HANDSHAKE_REJECT — define criteria for rejecting a joining peer and surface the rejection to the user
- [ ] peerSequence gap detection — detect and handle missed messages using sequences from STATE_DUMP (protocol in place, no action taken on gaps yet)
- [ ] Self-hosted Nostr relay — for LAN-only / air-gapped deployments
- [ ] TURN server support — for controllers behind symmetric NAT (known v1 limitation)
- [ ] BCN squawk duplicate detection across peers

---

## ATC Scope

- [ ] `QUICK_LOOK_TCP` — quicklook by controller position (stubbed, returns ok)
- [ ] `QUICK_LOOK_ALL` — quicklook all (stubbed)
- [ ] `INIT_CNTL_BY_ID` — initiate control by callsign/FLID (stubbed, requires flight plan lookup)
- [ ] `HND_OFF_ACCEPT_NEAR` — currently accepts first incoming handoff; should accept nearest to range ring center
- [ ] Videomaps — load and render video map overlays `[spec]`
- [ ] Geographic underlay (Leaflet tile layer beneath radar symbology)
- [ ] Hybrid display mode (muted tiles + synthetic symbology)
- [ ] Vector geo data — source and load theater boundary/coastline/airspace data (IndexedDB storage)
- [ ] ERAM and TopSky ODS profiles

---

## CATCC Scope

- [ ] PAR window — precision approach radar display

---

## AIC Scope

*Full module deferred. Spec not yet written.*

- [ ] AIC scope canvas and datablock rendering
- [ ] AIC module room WebRTC events
- [ ] Group labels, picture geometry, fighter assignments
- [ ] Olympus PUT commands (tasking) — out of scope v1

---

## Flight Strips `[spec]`

- [ ] Strip UI — data model is defined, UI not yet built

---

## Login / Session `[spec]`

- [ ] Review login spec for any outstanding items

---

## Infrastructure

- [ ] Bundle server as standalone executable (pkg or nexe) — no Node.js install required for end users
- [ ] RWR module — bearing-only display for RWR contacts (method 16), deferred
- [ ] SRS integration — future feature

---

## Known Limitations (not bugs, by design)

- Safari explicitly unsupported
- Symmetric NAT: WebRTC connections will fail without TURN (deferred)
- Olympus PUT commands (unit tasking from AIC) out of scope for v1
