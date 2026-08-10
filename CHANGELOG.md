# Changelog

All notable changes to `@zakkster/lite-di-orchestrator` are documented here. The
format follows Keep a Changelog; this project adheres to Semantic Versioning.

## [1.0.0-alpha.1] - 2026-08-10

The graceful-shutdown / process-lifecycle CAPSTONE of the `@zakkster/lite-di-*`
service-kernel line. First public alpha.

### Added

- `Orchestrator` class -- the ordered async teardown of a lite-di service kernel.
  - `new Orchestrator(container, { health?, supervisor? })` -- PURE and INERT; the
    constructor touches NO process global. `container` is required (an object with a
    `shutdown()` method); `health` (if present) must expose `drain()`; `supervisor`
    (if present) must expose `shutdown()`. An unknown option key throws with a
    did-you-mean hint.
  - `.step(name, fn)` -- COLD, append-only. Registers an ordered app-cleanup step
    that runs during STOPPING, after `supervisor.shutdown()` and before
    `container.shutdown()`, while the graph is still fully constructed.
  - `.listen({ signals, exit, force })` -- the ONLY method that touches `process`.
    Traps `SIGTERM`/`SIGINT` (default) and drives `shutdown()` on each. Returns an
    idempotent disposer that removes every handler. A second install throws.
  - `.shutdown({ exit, timers, deadlineMs })` -- the ordered teardown. IDEMPOTENT
    (a second call returns the same promise). Always ends by calling `exit(code)`
    EXACTLY ONCE, guarded by an `_exited` latch. `exit`/`timers`/`deadlineMs`
    (default 10000) are injectable for tests.
  - `.phase` (getter) -- the current lifecycle phase int. HOT: 0.000 B/op.
- The ratified teardown order: `health.drain()` -> `supervisor.shutdown()` ->
  steps in order -> `container.shutdown()` -> `exit(code)`.
- Exit codes `EXITS = { OK: 0, DIRTY: 1, DEADLINE: 2, FORCED: 3 }` and phases
  `STATES = { RUNNING: 0, DRAINING: 1, STOPPING: 2, STOPPED: 3, FORCED: 4 }`
  (both frozen). `VERSION` export (three-place synced).
- Fail-closed async discipline: each phase runs in its own `try { await ... }
  catch { dirty = true; }`, so a throwing `drain()`, a rejecting collaborator, or a
  thenable with a throwing `.then` getter records a DIRTY exit and ADVANCES -- it
  never wedges the machine or skips the deadline/exit. A hung phase is bounded by a
  one-shot deadline timer that force-exits with DEADLINE. A second signal
  mid-teardown force-exits with FORCED.
- Full TypeScript declarations (`Orchestrator.d.ts`), `llms.txt`, `README.md`,
  `COOKBOOK.md`, and `decisions/0001-orchestrator-model.md`.
- Torture gate (`node --expose-gc test/torture.mjs`, lite-leak + lite-gc-profiler):
  laws + ASCII control, inert-construct signal census, the ratified sequence,
  fail-closed exits (DIRTY/DEADLINE/FORCED, exit exactly once), disposer +
  idempotency, the 0 B/op `phase` getter (hard-gated two ways), a 1e4-lifecycle
  retention soak (listener census + lite-leak + heap delta), a real
  container+supervisor+health money composition, and the DI_ALLOC_BREAK /
  DI_TORTURE_BREAK / DI_ASCII_BREAK controls that each force a non-zero exit.

[1.0.0-alpha.1]: https://github.com/PeshoVurtoleta/lite-di-orchestrator/releases/tag/v1.0.0-alpha.1
