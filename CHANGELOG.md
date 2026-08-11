# Changelog

All notable changes to `@zakkster/lite-di-orchestrator` are documented here. The
format follows Keep a Changelog; this project adheres to Semantic Versioning.

## [1.0.0] - 2026-08-11

Promotion to stable. The public surface is frozen exactly as shipped at
`1.0.0-alpha.1` -- the `Orchestrator` class (`step`, `listen`, `shutdown`, the
`phase` getter), the frozen `EXITS` and `STATES` enums, and `VERSION`. No exports
added or removed.

### Changed
- The retention gate is now a real finalization residual, not a `size() === 0`
  tautology. The soak tracks each full orchestrator lifecycle WITHOUT untracking,
  settles hard, and asserts the finalization residual stays within a fixed ceiling
  (`size() <= 16`) that does NOT scale with cycle count. Behavior unchanged; this is
  the gate that now PROVES leak-freedom.

### Proven
- Downstream consumer: `examples/service-kernel.mjs`, the composed capstone reference
  service -- a full `db <- cache <- api` container graph under a supervisor, a health
  surface, and a leader lock, retired by this orchestrator. It asserts, with
  `node:assert`, the ratified teardown ORDER (`health.drain()` ->
  `supervisor.shutdown()` -> steps -> `container.shutdown()` -> `exit(OK)` EXACTLY
  once), that liveness stays UP through the drain, the DIRTY and DEADLINE exit paths,
  and the `listen()` signal seam (install / dispose / double-listen-throws on
  `SIGUSR2`, with no real `SIGTERM` touched). Every claim is tamper-proven (a broken
  contract exits non-zero). `npm run example` is a hard gate folded into `verify` /
  `prepublishOnly`.
- `node --expose-gc test/torture.mjs`: the `phase` getter measures 0.000 B/op in both
  the running and stopped states over 1,000,000 reads; a 10,000-lifecycle retention
  soak leaves the finalization residual at `size() 0/16` with a listener census of
  `SIGTERM=0 SIGINT=0` and `gc major=0 minor=0`. The `DI_ALLOC_BREAK`,
  `DI_ASCII_BREAK`, and `DI_TORTURE_BREAK` controls each force a non-zero exit.
- `node:test`: 113/113 pass.

### API frozen at 1.0.0
The public surface is exactly the `Orchestrator` class, `EXITS`, `STATES`, and
`VERSION`. The teardown order (`health.drain()` -> `supervisor.shutdown()` -> steps
-> `container.shutdown()` -> `exit(code)`) is frozen. Deliberately NOT included --
any would be a post-1.0.0 (1.1) change, never a 1.0.x slip (see
`decisions/0001-orchestrator-model.md`):
- NOT a process manager or init system -- Kubernetes / systemd / pm2 SUPERVISE the
  process and send the signals; this runs INSIDE one process and produces the exit
  code they read.
- NOT an HTTP server or router -- wire your server's `close()` as a `step`.
- NOT a health / readiness aggregator -- that is `@zakkster/lite-di-health`; this
  pulls its `drain()` at the right moment.
- NOT a supervision tree or restart policy -- that is `@zakkster/lite-di-supervisor`;
  this calls its `shutdown()` to disarm it.
- NOT a DI container -- that is `@zakkster/lite-di-container`; this calls its
  `shutdown()` last and wires none of the graph.

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

[1.0.0]: https://github.com/PeshoVurtoleta/lite-di-orchestrator/releases/tag/v1.0.0
[1.0.0-alpha.1]: https://github.com/PeshoVurtoleta/lite-di-orchestrator/releases/tag/v1.0.0-alpha.1
