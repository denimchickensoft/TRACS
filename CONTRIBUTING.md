# Contributing to TRACS

Thanks for your interest in improving TRACS. Bug reports are welcome. Fixes and features are considered case by case, so for anything big, open an issue first and we can talk it over before you put the work in.

## Getting set up

Requirements: Node.js 22+ and Git.

```bash
git clone https://github.com/denimchickensoft/TRACS.git
cd TRACS
npm install        # also enables the repo's git hooks (see below)
npm run dev        # local server + Vite dev client
```

`npm run dev` starts the local server and the Vite dev client together. You'll need a data source to connect to: a DCS Olympus server, a Tacview real-time telemetry port, or a TRACS Relay. The README covers each one. For the desktop app, `npm run electron:dev` builds the client and launches Electron.

## Before you open a pull request

- **Lint:** run `npm run lint`. It runs ESLint and checks that the generated copies of shared server files (the Tacview parser, the protocol version, the detection-config example) are in sync. It must pass with no errors.
- **Tests:** run `npm test`. Unit tests live in `test/`, mirroring the package they cover, and run in CI on every push and pull request.
- **Unused code:** `npm run knip` reports unused files, exports and dependencies. Please don't add new findings.
- **Test your change** against a real or mock data source, and say how you tested it in the pull request.
- **Keep it focused.** One fix or feature per pull request is much easier to review than a bundle.

## Things worth knowing

- **Tacview parser: edit only `server/src/tacviewCore.js`.** `relay/tacviewCore.js` is a generated copy, because the relay is built and deployed on its own. The same goes for `server/src/protocolVersion.js` and `server/tacviewDetectionConfig.example.json`, whose relay (and client) copies are generated too. Run `npm run sync:tacview-core` after editing. The pre-commit hook in `.githooks/pre-commit` also does it automatically; `npm install` enables it through `core.hooksPath`.
- **Comments explain why.** Write comments that make sense on their own to someone reading the code for the first time. Don't reference private notes, chat history or dates; git history already records when and who.
- **Console messages:** in the client, send diagnostic output through `log.debug`/`log.info` from `client/src/utils/log.js`, which is silent in production builds unless the `tracs.debug` localStorage flag is set. Keep `console.warn`/`console.error` for real problems. Use plain hyphens (`-`), not em dashes, in console strings. Some terminals render em dashes as garbage.
- **Navigraph data is never committed.** Fixes, navaids, airways and procedures are extracted on each user's own machine from their own LittleNavMap database. Only the non-Navigraph theatre data under `server/navdata/cache/` is tracked.
- **Releases** are cut by maintainers. Pushing a `vX.Y.Z` tag builds the desktop app, and a `relay-vX.Y.Z` tag builds the relay; see the README's "Releasing" section.

## Reporting bugs and security issues

- **Bugs:** open an issue using the bug report template. Attach the log file from **File → Open Logs Folder**; it makes most problems much faster to track down.
- **Security problems:** please don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the project's license, the GNU General Public License v3.0 or later (see [LICENSE](LICENSE)).
