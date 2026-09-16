# AGENTS.md

- This repository is the canonical source for the published `@y0usaf/pi-jev` npm package.
- `y0usaf/pi-flake` vendors a copy of `src/` as a bundled pi extension. A change here needs the same change there, or the two drift.
- Runtime dependencies stay at zero. The Jev client is `fetch` plus types; do not add a client library.
- Pi-bundled imports (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox`) belong in `peerDependencies` with a `"*"` range and must not be bundled.
- The gate fails open by design. Do not change an error path to block a tool call.
- Shadow mode is the default. Any change that makes enforcement implicit needs justifying in the README.
- Threshold changes belong with a measurement in the `## Calibration` table, not with a guess.
- Publishing goes through `.github/workflows/publish.yml` (trusted publishing / OIDC). The fallback token lives outside this repo.
