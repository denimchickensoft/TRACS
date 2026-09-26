# Security Policy

## Reporting a vulnerability

Please **don't** report security problems in a public issue. Use GitHub's private reporting instead: on the repository's **Security** tab, choose **Report a vulnerability**. Only the maintainer can see the report.

Please include what you found, how to reproduce it, and which component it affects (desktop app, local server, or TRACS Relay). You'll get a reply as soon as the maintainer is able. This is a volunteer project, so please allow some time.

## Supported versions

Only the latest release of the TRACS desktop app and the latest release of the TRACS Relay receive security fixes.

## Trust model

Knowing what TRACS does and doesn't protect helps you judge whether something is a vulnerability.

- **The local server** (built into the desktop app) listens only on this machine (`127.0.0.1`). It has no login of its own. It rejects requests from other websites and from DNS-rebinding hosts. Setting `TRACS_HOST` opts in to LAN access, and then anyone who can reach the port can read and control it.
- **The TRACS Relay** trusts its authenticated clients.
  - Coalition passwords control who can *connect*. They don't hide one coalition's data from a client that deliberately misbehaves: a modified client with a valid password can see the full picture the relay forwards.
  - Don't share relay passwords with players you don't trust.
  - The relay speaks plain `ws://`. Use a TLS reverse proxy if it's exposed to the internet.
- **Peer-to-peer sync without a relay** sets up connections through public Nostr relays and Google STUN servers. Connection details are encrypted only when a session password is set.
