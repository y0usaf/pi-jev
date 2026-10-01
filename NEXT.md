# What to add next

Decided 2026-09-19. This settles the question left open on 2026-09-17 ("what else
can we add to it?"), from the two read-only surveys in
`~/dev/sandbox/*/pi-jev-*/report.md` and the owner's own probe of ten candidate
surfaces (203 live requests, `/tmp/jev-probe/report2.txt`). Everything here is
either already measured by that probe or adds no request at all.

## Shipped

- **Verdict journal and `/jev log`** (#7). Flagged verdicts persist as `jev`
  custom entries and survive `/reload`, `/resume`, and `/fork`. This is the
  field data every item below waits on.
- **Hygiene** (#7). `maxStateChars` is gone, and the README says print/JSON
  where it said RPC.
- **Codemode** (0.2.3, 0.3.0). Calls a script makes keep their results; the
  output judge reads the `codemode` result instead, measured in README
  `### Under codemode`.

## Next: taint-gated reply leak check (`message_end`)

The output judge catches a secret in tool *output* and asks the model not to repeat
it (README, "The output judge"). Nothing checks the reply. Add a `message_end` handler that runs
the existing, measured `leaks_secret` question against the assistant's own text
**only when the last judged tool result was classified `leak`**.

- Hook: `message_end`; taint flag set in the existing `tool_result` handler.
  ~40-60 lines, helper modelled on `judgeOutput`.
- **+0 requests on ordinary turns** — the gate makes it fire only after a leak,
  which the probe says is rare. ~300 ms on those messages only.
- Ship **off by default** (`output.judgeReplies: false`): the 0.90 threshold was
  calibrated on bash output, not prose, and AGENTS.md requires a measurement for a
  new distribution. A local prefilter (long base64/hex run) keeps it quiet.
- Clear the taint flag on `agent_settled` so it cannot stick.
- Honest limit: `message_end` cannot redact, so this is a warning, not a fix.

## Queued: Jev requests through pi's classifier runtime

pi 0.99 ships a `typesafe` provider and `ctx.modelRegistry.classify()`. It sends
the same body (`{ model, state, questions }`) to the same endpoint
(`https://api.typesafe.ai/v1/systemone`), maps `bool` to `noul`, rejects a
response that skips a question, and retries under a timeout. Moving to it
deletes most of `src/client.ts`, the `endpoint` knob, and the `configDirName()`
fallback for hosts before 0.79.7, and lets `model` name Jev on OpenRouter,
Vercel AI Gateway, OpenCode, or Cloudflare with credentials pi already holds.
Calibration carries over for `typesafe/jev-latest`: the request is unchanged.

It needs pi 0.99 or later. 0.99.0 shipped 2026-09-29 and issue #1 came from a
host on 0.74.2, so not yet. Do it as 0.4.0 once older hosts stop turning up in
issues, with a load-time notice on a host without `modelRegistry.classify`
rather than a silent fail-open, and change the AGENTS.md "fetch plus types" rule
with it.

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
