# Verification — resource refactor + double-audio fix

**Status: green.** Typecheck clean, full suite passing, including 7 new tests that lock in the "conversation is a resource, not in-band" invariant.

## Gate results

| Check | Result |
|---|---|
| `pnpm typecheck` (`tsc --noEmit`) | ✅ exit 0 |
| `pnpm test` (`vitest run`) | ✅ **92 passed / 4 skipped** (11 files) |

The 4 skipped are `tests/media-smoke.test.ts` — they load the real Moonshine/kokoro/Silero models and are gated off the default run (covered live by the E2E below).

```
✓ tests/decide.test.ts        (15 tests)   ← was 8; +7 resource-rendering invariants
✓ tests/orchestrator.test.ts  (8 tests)    heartbeat / busy-lock / write-back unchanged
✓ tests/tools.test.ts         (7 tests)
✓ tests/cerebras.test.ts      (7 tests)    streamed tool_call accumulator
✓ tests/resources.test.ts     (6 tests)    append-log
✓ tests/ws.test.ts            (2 tests)    resource spine over WS
✓ tests/vad.test.ts           (2 tests)
✓ tests/media-pcm.test.ts     (8 tests)
✓ packages/web/src/validate.test.ts (17)   boundary parser
✓ packages/web/src/store.test.ts    (12)   append-log consumer
✓ packages/web/src/lib/metrics.test.ts (8)
↓ tests/media-smoke.test.ts   (4 skipped)  real models — run live in E2E
```

## What changed

**1. Conversation → resource (not in-band)** — `decide.ts`, `identity.ts`, `main.ts`
- The transcript delta is now rendered as a `<transcript>` resource block the model **observes**, inside one neutral heartbeat turn — never a `{role:'user'}` message addressed to it.
- The **deliverables** log is now injected too, as a `<deliverables>` block, so Gemma observes sub-agent artifacts as a resource and can `share_screen` one by `deliverableId`.
- Identity prompt names the framing: "these are ambient shared state you watch — never messages addressed to you."
- `decide`'s hot-path signature `(delta) => Promise<Decision>` is unchanged → orchestrator + its 8 tests untouched.

**2. Double-audio race** — `packages/web/src/ws.ts`
- Root cause: the browser held **two live WS sockets**; each receives the broadcast `play` frame, and `playback.ts` schedules each after the previous tail → the same utterance plays back-to-back.
- Fix: `connect()` is now idempotent (refuses a second socket while one is CONNECTING/OPEN); `import.meta.hot.dispose` tears the old socket down on hot-reload. Invariant: **exactly one live socket** → each utterance delivered once.

## New tests (the invariant guard)

`tests/decide.test.ts` → "resource rendering — conversation is a resource, not in-band":
transcript wraps in `<transcript>` (not `[human:me]`), agent self-labeled `you (agent)`, deliverables carry `id`+`kind`+`title` for `share_screen`, and the heartbeat frames everything as "not messages addressed to you." If anyone reverts to an in-band user turn, these fail.
