# AGENTS.md

Maintainer rules for this repository.

## Layout

- This repository is the canonical source for the published `@y0usaf/pi-jev` npm package.
- `y0usaf/pi-flake` vendors a copy of `src/` and this README as a bundled pi extension. A change here needs a matching change there, or the two drift.

## Code

- Runtime dependencies stay at zero. The Jev client is `fetch` plus types, so do not add a client library.
- Pi-bundled imports (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) belong in `peerDependencies` with a `"*"` range and must not be bundled.
- The gate fails open by design. Do not change an error path to block a tool call.
- Shadow mode is the default. Any change that makes enforcement implicit needs justifying in the README.
- A threshold change belongs with a measurement in the `## Calibration` table, not with a guess.

## Publishing

- A GitHub release publishes from `.github/workflows/publish.yml` using trusted publishing (OIDC), so the repo holds no npm token and no OTP is involved.
- One-time setup, npmjs.com, package settings, Trusted Publisher: user `y0usaf`, repository `pi-jev`, workflow `publish.yml`, environment empty.
- A local publish before that is configured needs a token with 2FA bypass enabled:

  ```bash
  npm publish --access public --//registry.npmjs.org/:_authToken="$(cat path/to/token)"
  ```

- The package name is scoped (`@y0usaf/pi-jev`) because the npm token is scoped to `@y0usaf`. A bare name cannot be published with it.
