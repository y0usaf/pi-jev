# What to add next

Decided 2026-09-19. This settles the question left open on 2026-09-17 ("what else
can we add to it?"), from the two read-only surveys in
`~/dev/sandbox/*/pi-jev-*/report.md` and the owner's own probe of ten candidate
surfaces (203 live requests, `/tmp/jev-probe/report2.txt`). Everything here is
either already measured by that probe or adds no request at all.

Order is the build order. Only the first item is worth starting now; the rest are
queued behind it.

## 1. Verdict journal: persist what the extension already decided

`last` and `lastOutput` (`src/index.ts:116-117`) are in-memory only, so `/jev last`
loses every flag on `/reload`, `/resume`, or `/fork` — exactly when a record
matters. Write each **flagged** gate verdict and each leak/advice output verdict
with `pi.appendEntry("jev", ...)`, rehydrate on `session_start`
(`src/index.ts:130`), and add `/jev log` beside the existing `/jev last`.

- Hooks: `appendEntry` (not in LLM context) + `session_start`; no new network call,
  no new question, **+0 Jev requests**.
- New file `src/journal.ts`, calls at `src/index.ts:160` and `:213`, `/jev log`
  near `:411`.
- This is the item that turns the smoke calibration (`README.md:141-169`) into
  real data: the flags it records are the only ground truth the project will ever
  get about what fires in the field. Every other candidate that needs calibration
  gets cheaper once this exists.
- Fail open: a journal write error must never escape a handler. Filter
  `customType === "jev"` exactly and read defensively (session files are
  hand-editable).

## 2. Taint-gated reply leak check (`message_end`)

The output judge catches a secret in tool *output* and asks the model not to repeat
it (`README.md:45`). Nothing checks the reply. Add a `message_end` handler that runs
the existing, measured `leaks_secret` question against the assistant's own text
**only when the last judged tool result was classified `leak`**.

- Hook: `message_end`; taint flag set in the existing `tool_result` handler at
  `src/index.ts:213`. ~40-60 lines, helper modelled on `judgeOutput` (`:257`).
- **+0 requests on ordinary turns** — the gate makes it fire only after a leak,
  which the probe says is rare. ~300 ms on those messages only.
- Ship **off by default** (`output.judgeReplies: false`): the 0.90 threshold was
  calibrated on bash output, not prose, and AGENTS.md requires a measurement for a
  new distribution. A local prefilter (long base64/hex run) keeps it quiet.
- Clear the taint flag on `agent_settled` so it cannot stick.
- Honest limit: `message_end` cannot redact, so this is a warning, not a fix.

## 3. Hygiene, before either of the above lands

- `maxStateChars` is documented (`README.md:78`) and parsed (`src/config.ts:114`)
  but **never read** — `buildGateState` caps per-string with `argumentChars` only.
  Delete the field and its README line, or implement it. It cannot stay a lie in a
  config the README tells you to edit.
- `README.md:28` says "Headless runs (`-p`, RPC) cannot show a prompt". RPC has a
  UI (`hasUI` is true there), so the gate *does* prompt in RPC. Say print/JSON.

## Queued behind those

- **Repeat-failure escalation**: a session `Map` keyed by `outputKey`
  (`src/output.ts:89`) appending "(seen Nx)" to the existing one-liner at
  `count >= 2`. +0 requests, ~15 lines — but it scolds a working fix-then-rerun
  loop, so it belongs on top of the journal's data, not before it.
- **Gate user `!`/`!!` commands** (`user_bash`): the same four questions, shadow
  only — that hook exposes no `block`, so it is observation-only by construction.
  The user typed the command deliberately, so expect it to be noise; build it only
  if the journal shows user-typed bash is where the damage actually happens.
- **End-of-run digest** (`agent_settled`): one request per run over the accumulated
  flag lines. Needs its own calibration and overlaps the journal; only after both.

## Rejected, with the reason

- **Skill routing** (`before_agent_start`): the owner's own probe is clean (top-1
  12/12, 2.88-2.99 vs <=0.92) and the owner still declined it — skill choice is
  policy, not inference, and it costs +1 request per turn. Not ours to decide.
- **A fifth `writes_secret` gate question**: `buildGateState` elides every argument
  to 400 chars (`src/gate.ts:120-135`), so a key past char 400 is invisible and the
  question mostly sees boilerplate. The 0.90 gap was measured on output, not
  arguments, so it does not transfer.
- **Rewriting a flagged call's input instead of blocking it**: a bad rewrite is
  worse than a block, `rm -ri` hangs a headless box, and there is no calibration
  path for "which rewrites are safe". pi-jev stays a reporter/confirmer.
- **Auto-retrying a `transient` failure**: `retry_safe` measured overlapping, and a
  `tool_result` handler can only rewrite content, not re-run a tool.
- **`needs_network`**, **difficulty -> model**, **compaction retention**, **prompt
  classification**, **transcript drift at `turn_end`**: rejected on the owner's own
  measurements, or already built and deliberately retired (`pi-sentinel-audit`).
- **More `/jev` sub-commands** that just ask Jev a question: `jev_ask` already is
  that door, and its measured real usage is ~0.

## Not in this document

The publish path. It is a separate concern with its own decision; see `PUBLISHING.md`.
