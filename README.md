# @zakkster/lite-di-orchestrator

> Graceful-shutdown / process-lifecycle capstone for a lite-di service kernel. Catch SIGTERM, drain readiness (readyz fails; livez stays up), disarm the self-healing supervisor, run ordered cleanup steps while the graph is still alive, dismantle the container LAST, all under one hard DEADLINE, and always exit EXACTLY ONCE with a diagnostic code. The constructor is inert; signal ownership is opt-in and reversible.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-di-orchestrator.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-di-orchestrator)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-phase-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-di-orchestrator?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-di-orchestrator)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-di-orchestrator?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-di-orchestrator)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-di-orchestrator?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-di-orchestrator)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The graceful shutdown the DI line was missing

Your service has a container that tears down, a supervisor that heals, and a health
surface that reports -- but on `SIGTERM` those have to be retired in the RIGHT
ORDER, under a deadline, or shutdown goes wrong in ways that only show up in
production. Drain readiness too late and the load balancer keeps sending work into
a dying process. Tear the container down while the supervisor is still armed and it
tries to RESTART the very services you are killing. Fail the liveness probe while
draining and the orchestrator SIGKILLs you mid-flight. Let a cleanup step hang and
you linger until the platform kills you hard. And a shutdown that exits twice -- or
not at all -- is its own bug.

`lite-di-orchestrator` is that shutdown machine. It owns ONE ratified order --
`health.drain()` -> `supervisor.shutdown()` -> your steps -> `container.shutdown()`
-> `exit(code)` -- runs each phase caught on its own (a throw/rejection/hang never
wedges the machine), bounds the whole thing with a hard deadline, and always calls
`exit(code)` EXACTLY ONCE with a diagnostic code. The constructor touches NO process
global; `listen()` is the only thing that grabs signals, and it hands them back via
an idempotent disposer. It is the capstone that closes the service kernel: the
container WIRES, the supervisor HEALS, health REPORTS, this package RETIRES.

```bash
npm install @zakkster/lite-di-orchestrator
```

No dependency -- not even a peer. The collaborators are duck-typed.

```javascript
import { Orchestrator } from '@zakkster/lite-di-orchestrator';

// container: any object with shutdown(); health: any with drain();
// supervisor: any with shutdown(). The DI line fits natively.
const orch = new Orchestrator(container, { health, supervisor });

orch.step('close-http',   () => server.close());   // runs while the graph is alive
orch.step('flush-metrics', () => metrics.flush());  // in registration order

// Opt in to signal ownership. The disposer reverses it (tests, embedded hosts).
const stop = orch.listen({ signals: ['SIGTERM', 'SIGINT'] });

// On SIGTERM:
//   drain readyz (livez stays up) -> stop healing -> steps -> tear down -> exit(0)
// A second SIGTERM mid-teardown -> exit(FORCED). A deadline overrun -> exit(DEADLINE).
```

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [The teardown sequence](#the-teardown-sequence)
- [API reference](#api-reference)
  - [Constructor](#constructor)
  - [Methods](#methods)
  - [Constants](#constants)
- [Composability with the DI line](#composability-with-the-di-line)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

## Why this exists

A graceful shutdown is a sequence problem, and every step in the sequence has a
failure mode that only bites in production. The ORDER is load-bearing: drain before
you stop healing before you run cleanup before you dismantle -- get it wrong and you
route traffic into a corpse, restart services you are killing, or use a service
after its dependency is gone. The DEADLINE is load-bearing: a cleanup step that
hangs must not hang the process; something has to force the exit. The EXIT is
load-bearing: it must fire exactly once, with a code an operator can read, no matter
which path (clean, dirty, timed-out, or force-signalled) got there.

This package makes that sequence the ONLY sequence and pins each rule with torture
assertions: the ratified order runs in exactly one direction; each phase is caught
in its own `try/await` so a throwing `drain()`, a rejecting collaborator, or a
hanging step records a diagnostic and ADVANCES; a one-shot deadline timer force-exits
a wedged sequence; a second signal force-exits immediately; and an `_exited` latch
guarantees `exit(code)` fires exactly once across every path. It adds the two things
a hand-rolled `process.on('SIGTERM', ...)` cannot: correct-by-construction ORDERING
across the whole DI line, and a fail-closed DEADLINE + exactly-once EXIT. "Fail
closed on every unverified state," applied to the last thing a process ever does.

## What you get

- An `Orchestrator` over a container plus an optional health surface and supervisor,
  all DUCK-TYPED (`container.shutdown()`, `health.drain()`, `supervisor.shutdown()`)
  -- the real `@zakkster/lite-di-*` bricks fit natively, and so does anything
  matching their shapes. No dependency.
- The ratified teardown ORDER as the single source of truth:
  `health.drain()` -> `supervisor.shutdown()` -> steps (in registration order) ->
  `container.shutdown()` -> `exit(code)`. Drain first (k8s stops routing, livez
  stays up), supervisor before steps (nothing self-heals mid-teardown), container
  last (its reverse-topo teardown is the actual dismantling).
- Per-phase FAIL-CLOSED discipline: each phase runs in its own
  `try { await ... } catch { dirty = true; }`. A synchronously-throwing `drain()`, a
  collaborator whose `shutdown()` rejects, a thenable with a throwing `.then` getter,
  or a bad step records a DIRTY exit and the teardown CONTINUES -- one bad phase
  never aborts the rest and never wedges the machine.
- A hard DEADLINE: `deadlineMs` (default 10000) bounds the WHOLE sequence via a
  one-shot timer. A hung phase (a promise that never settles) is caught here and
  force-exits with `EXITS.DEADLINE` -- never by a hang.
- Exactly-once EXIT with a diagnostic code: `EXITS.OK` (clean), `DIRTY` (a phase
  failed but the sequence finished in time), `DEADLINE` (overran), `FORCED` (a
  second signal). An `_exited` latch every route checks-and-sets guarantees a single
  `exit(code)` call.
- OPT-IN, REVERSIBLE signal ownership: the constructor touches NO process global;
  `listen()` is the only method calling `process.on`, a second install throws, and
  the returned disposer `process.off`s every handler (idempotent). Embeddable and
  testable by construction.
- A 0-allocation `phase` getter -- the current lifecycle phase int, hard-gated at
  0.000 B/op, readable as often as you like.
- Fail-closed registration: a null/shutdown-less container, a health without
  `drain()` or a supervisor without `shutdown()`, an unknown option (constructor,
  listen, or shutdown), a bad step name/fn, a non-function `exit`, malformed
  `timers`, or a non-positive `deadlineMs` all throw.

Full types ship in [`Orchestrator.d.ts`](./Orchestrator.d.ts).

## The teardown sequence

<details>
<summary>The ratified order, why each phase is where it is, and the exit codes (click to expand)</summary>

```
shutdown():
  RUNNING  -> DRAINING:  if health:      health.drain()            (readyz fails; livez untouched)
  DRAINING -> STOPPING:  if supervisor:  await supervisor.shutdown()   (disarm self-healing FIRST)
                         for each step in order: await step.fn()       (graph still alive)
                         await container.shutdown()                    (reverse-topo teardown, LAST)
  STOPPING -> STOPPED:   exit(code)
```

- **Drain FIRST.** `health.drain()` flips `readyz()` to not-ready while leaving
  `livez()` untouched, so a load balancer stops routing new work but the platform
  does NOT SIGKILL you for failing liveness mid-shutdown.
- **Supervisor BEFORE steps.** `supervisor.shutdown()` only STOPS supervising -- it
  does not tear the graph down. Disarming it first means nothing tries to self-heal
  a service while you are retiring it. Because the container graph is still fully
  constructed, your steps can still resolve and use services.
- **Container LAST.** The container's `shutdown()` is the actual dismantling
  (reverse-topological teardown of every singleton), so it runs after everything
  that might still need a service has finished.

Each phase is caught independently, so a failure records a diagnostic and the
sequence advances:

| Exit code           | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `EXITS.OK` (0)       | Every phase completed cleanly within the deadline.                      |
| `EXITS.DIRTY` (1)    | A phase threw/rejected but the sequence still finished in time.         |
| `EXITS.DEADLINE` (2) | The whole sequence overran `deadlineMs`; a one-shot timer force-exited. |
| `EXITS.FORCED` (3)   | A SECOND signal arrived while a shutdown was already in flight.         |

`exit(code)` is called EXACTLY ONCE across ALL of these paths, guarded by the
`_exited` latch.

</details>

## API reference

### Constructor

```typescript
new Orchestrator(container: { shutdown(...): unknown }, options?: {
  health?: { drain(): unknown };
  supervisor?: { shutdown(...): unknown };
})
```

- **`container`** -- REQUIRED. A non-null object exposing a `shutdown()` function
  (else `TypeError`). Its teardown is the last phase.
- **`options`** -- optional. Known keys are `health` and `supervisor`; any other key
  throws with a did-you-mean hint (`unknown option 'helth'. Did you mean 'health'?`).
- **`health`** -- optional. If present, must expose a `drain()` function (else
  `TypeError`). Pulled first (`RUNNING -> DRAINING`).
- **`supervisor`** -- optional. If present, must expose a `shutdown()` function (else
  `TypeError`). Disarmed before your steps run.

The constructor is PURE and INERT: it touches NO process global and sets every field
unconditionally (a stable hidden class). Nothing happens until `listen()` or
`shutdown()`.

### Methods

```typescript
step(name: string | symbol, fn: () => unknown): void
listen(options?: { signals?: string[]; exit?: (code: number) => void; force?: boolean }): () => void
shutdown(options?: { exit?: (code: number) => void; timers?: { setTimeout; clearTimeout }; deadlineMs?: number }): Promise<void>
get phase(): number
```

- **`step(name, fn)`** -- COLD, append-only. Register an app-cleanup step under a
  unique non-empty string|symbol `name` (a duplicate throws); `fn` must be a function
  (else `TypeError`). Steps run during `STOPPING`, in registration order, AFTER
  `supervisor.shutdown()` and BEFORE `container.shutdown()` -- the graph is still
  fully constructed, so a step may resolve and use services. A step that throws or
  rejects records a DIRTY exit and does NOT abort the rest.
- **`listen(options?)`** -- the ONLY method that touches `process`. `signals`
  defaults to `['SIGTERM', 'SIGINT']`; `exit` defaults to `process.exit`; `force` is
  reserved. Installs one handler per signal (each drives `shutdown` with the injected
  `exit`). A second install while armed THROWS. Returns an idempotent DISPOSER that
  `process.off`s every signal. A second signal arriving mid-teardown force-exits with
  `EXITS.FORCED`.
- **`shutdown(options?)`** -- the ordered async teardown. `exit` defaults to
  `process.exit`; `timers` defaults to the host `{ setTimeout, clearTimeout }`;
  `deadlineMs` defaults to `10000`. IDEMPOTENT: a second call (or one from the signal
  handler) returns the SAME promise and never re-runs. Always ends by calling
  `exit(code)` EXACTLY ONCE. Resolves after `exit` has fired. `exit`/`timers`/
  `deadlineMs` are injectable so the whole sequence is unit-testable.
- **`phase`** (getter) -- HOT, 0.000 B/op. The current lifecycle phase (one of
  `STATES`). A single property read: no branch, no allocation.

### Constants

```typescript
STATES = { RUNNING: 0, DRAINING: 1, STOPPING: 2, STOPPED: 3, FORCED: 4 }  // frozen int enum
EXITS  = { OK: 0, DIRTY: 1, DEADLINE: 2, FORCED: 3 }                      // frozen int enum
VERSION                                                                   // version string, three-place-synced
```

| Export             | Type            | Value / meaning                                                    |
| ------------------ | --------------- | ------------------------------------------------------------------ |
| `STATES.RUNNING`   | `number` (`0`)  | Nominal operation; no shutdown in flight.                          |
| `STATES.DRAINING`  | `number` (`1`)  | `health.drain()` ran; `readyz()` fails, `livez()` untouched.       |
| `STATES.STOPPING`  | `number` (`2`)  | Supervisor disarmed; steps + container teardown running.           |
| `STATES.STOPPED`   | `number` (`3`)  | Sequence complete (or deadline-exited); `exit()` has fired.        |
| `STATES.FORCED`    | `number` (`4`)  | A second signal forced an immediate exit mid-teardown.             |
| `EXITS.OK`         | `number` (`0`)  | Every phase completed cleanly within the deadline.                 |
| `EXITS.DIRTY`      | `number` (`1`)  | A phase threw/rejected but the sequence still finished in time.    |
| `EXITS.DEADLINE`   | `number` (`2`)  | The sequence overran `deadlineMs`; the one-shot timer force-exited.|
| `EXITS.FORCED`     | `number` (`3`)  | A second signal arrived while a shutdown was already in flight.    |
| `VERSION`          | `string`        | `'1.0.0-alpha.1'`.                                                  |

## Composability with the DI line

The full kernel: subsystems wired in a container, a supervisor healing them, a
health surface folding the supervisor's `check()` into readiness, and the
Orchestrator retiring all three in the ratified order on `SIGTERM`.

```javascript
import { Container } from '@zakkster/lite-di-container';
import { Supervisor, STRATEGIES } from '@zakkster/lite-di-supervisor';
import { Health, LANES } from '@zakkster/lite-di-health';
import { Orchestrator } from '@zakkster/lite-di-orchestrator';

// --- Subsystems, wired + supervised. ---------------------------------------
const c = new Container();
c.singleton('pool', Pool);
c.singleton('repo', Repo, ['pool']);
c.singleton('worker', Worker, ['repo']);
c.boot();

const sup = new Supervisor(c, {
  children: ['pool', 'repo', 'worker'],
  strategy: STRATEGIES.REST_FOR_ONE,
});
await sup.start();

// --- The readiness surface. -------------------------------------------------
const health = new Health();
health.watchSupervisor('kernel', sup, LANES.READY);   // supervisor healthy -> ready
health.source('proc', () => true, LANES.LIVE);        // the process is alive

// --- The lifecycle capstone. ------------------------------------------------
const orch = new Orchestrator(c, { health, supervisor: sup });
orch.step('close-http', () => new Promise((res) => server.close(res)));
orch.listen();   // trap SIGTERM + SIGINT

// SIGTERM ->
//   health.drain()   readyz 503, livez 200   (k8s stops routing, keeps you alive)
//   sup.shutdown()   self-healing disarmed    (nothing restarts mid-teardown)
//   close-http       in-flight requests finish; new ones already refused
//   c.shutdown()     reverse-topo teardown: worker -> repo -> pool
//   process.exit(0)  EXITS.OK
```

Every stage snaps onto the DI line, but nothing is REQUIRED: the collaborators are
duck-typed, so any object with the right method composes and this package carries no
dependency. The container owns the instances, the supervisor owns the healing,
health owns the verdict -- and this package owns the ORDER they are retired in.

## Zero-GC design notes

<details>
<summary>Why there is one hot lane, what it allocates (nothing), and the soak (click to expand)</summary>

Unlike its siblings, this is a COLD lifecycle machine: a shutdown runs ONCE per
process, so the teardown path (`step`, `listen`, `shutdown`, the phase walk)
allocates freely -- a promise here or a closure there costs nothing over a process
lifetime. There is no steady-state hot loop to gate. The ONLY hot lane is the
`phase` getter -- a lifecycle probe a supervisor loop or an admin endpoint may read
often -- and it is a single property read: no branch, no closure, no allocation.

| Path                       | Steady-state allocations                          |
| -------------------------- | ------------------------------------------------- |
| `get phase()`              | **0.000 B/op** (HARD gate, 1e6 reads, `maxMajor` 0) |
| `step` / `listen`          | cold by design (registration + one-time signal arm) |
| `shutdown` (the teardown)  | cold by design (runs once per process)            |

Because there is no frame loop, the retention concern is a SOAK, not a frame budget.
The torture gate (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`, under
`--expose-gc`) proves both the hot getter and the soak:

- **`phase`**: 0.000 B/op over 1e6 reads (measured two ways -- `measureAllocs`
  `maxBytesPerCall` 0 AND `measureOps` `stabilize:'deep'` with `maxMajor` 0), read
  across different phases so it is not a constant-folded value.
- **Retention soak**: 1e4 full lifecycles (`new Orchestrator` + `step` + `listen` +
  `shutdown` + dispose). After the soak the signal-listener census returns EXACTLY to
  baseline (every `listen()` handler removed by its disposer -- no handler leak),
  every instance finalizes (lite-leak size 0, clean audit), and the heap delta stays
  under 64 KB.

Numbers reproduce with `node --expose-gc test/torture.mjs`. No gate output is a FAIL.

</details>

## Design decisions worth knowing

The forks were ratified in
[`decisions/0001-orchestrator-model.md`](./decisions/0001-orchestrator-model.md).

- **Signal ownership is OPT-IN and REVERSIBLE (fixed input).** The constructor
  touches no process global; `listen()` is the ONLY method calling `process.on`, and
  it returns an idempotent disposer that `process.off`s every signal. WHY: a library
  that grabs signals on import is un-embeddable and untestable -- it fights the host
  and leaks handlers across a hot reload. Inert-until-asked is the only composable
  default.
- **The teardown ORDER is fixed: drain -> supervisor -> steps -> container.** WHY:
  drain first so k8s stops routing while `/livez` stays up; supervisor before steps
  so nothing self-heals mid-teardown (it only STOPS supervising -- the graph is still
  constructed, so steps can still use services); container last because its
  reverse-topo teardown is the actual dismantling. Any other order routes traffic
  into a corpse, restarts services you are killing, or uses a service after its
  dependency is gone.
- **Every phase FAILS CLOSED independently.** Each phase is its own
  `try { await ... } catch { dirty = true; }`. WHY: a throwing `drain()`, a rejecting
  collaborator, a thenable with a throwing `.then` getter, or a bad step must record
  a diagnostic and ADVANCE -- a failing phase that aborted the rest, or wedged the
  machine, would leave the process half-torn-down and lingering. The cron-session
  thenable lesson, applied to teardown.
- **The deadline is a fail-CLOSED backstop, and exit fires EXACTLY ONCE.** A one-shot
  timer bounds the whole sequence (`EXITS.DEADLINE` on a hung phase), and an
  `_exited` latch every route checks-and-sets guarantees a single `exit(code)` across
  clean completion, the deadline, and a double-signal `EXITS.FORCED`. WHY: a shutdown
  that hangs forever, or exits twice, is its own production bug.

Every unverified state fails closed: a null/shutdown-less container, a health without
`drain()` or a supervisor without `shutdown()`, an unknown option (constructor,
listen, or shutdown) with a did-you-mean hint, a bad step name/fn, a non-function
`exit`, malformed `timers`, or a non-positive `deadlineMs` all throw; a second
`listen()` throws; the disposer is idempotent.

## Testing

- `npm test` -- `node:test` cases across construction, step/listen/shutdown
  validation, the ratified order, the exit-code matrix, disposer + idempotency, and
  the real-brick composition. (Owned by the qa stage.)
- `npm run torture` -- `node --expose-gc test/torture.mjs`: the laws + ASCII control,
  the inert-construct signal census (unchanged across 1e4 constructs), the ratified
  sequence, the fail-closed exits (DIRTY/DEADLINE/FORCED, exit exactly once), the
  disposer + idempotency, the 0.000 B/op `phase` gate over 1e6 reads, a 1e4-lifecycle
  retention soak (listener census + lite-leak + heap delta), a real
  container+supervisor+health money composition, and the DI_ALLOC_BREAK /
  DI_TORTURE_BREAK / DI_ASCII_BREAK controls that each force a non-zero exit.
- `npm run example` -- runs [`examples/service-kernel.mjs`](examples/service-kernel.mjs),
  a runnable, SELF-VERIFYING reference app that composes all five kernel modules
  (container + supervisor + health + lock + this package) into ONE self-healing
  backend service: boot -> a lock-guarded reconcile under a fencing lease -> a fault
  that SELF-HEALS (rest-for-one rebuild) -> a restart budget that escalates instead of
  hot-looping -> every construction guard failing closed -> a graceful "SIGTERM" drain
  in the ratified order (drain -> supervisor.shutdown -> steps -> container.shutdown,
  exit(OK) exactly once). Every claim is asserted with `node:assert/strict`, so a
  broken contract exits non-zero. It is the downstream consumer that proves this
  package's API in composition (the collaborators are dev deps a tarball consumer
  installs alongside it).
- `npm run verify` -- `npm test`, then `npm run torture`, then `npm run example` -- the
  publish gate (`prepublishOnly`).

## What this is not

- **Not a process manager or init system.** Kubernetes, systemd, and pm2 SUPERVISE
  processes and send the signals; this runs INSIDE one Node process and produces the
  exit code they read. It orchestrates a shutdown, not a fleet.
- **Not an HTTP server or router.** You wire your server's `close()` as a `step`;
  this owns the teardown order, not sockets.
- **Not a health / readiness aggregator.** That is `@zakkster/lite-di-health`; this
  pulls its `drain()` at the right moment in the sequence.
- **Not a supervision tree or restart policy.** That is
  `@zakkster/lite-di-supervisor`; this calls its `shutdown()` to disarm it before
  teardown.
- **Not a DI container.** That is `@zakkster/lite-di-container`; this calls its
  `shutdown()` last. The Orchestrator wires none of the graph -- it only retires it.

## Ecosystem

Part of the `@zakkster/lite-di-*` line -- a self-healing zero-GC backend service
kernel:

- `@zakkster/lite-di-container` -- the SPINE: DI wiring, lifetimes, and the
  `invalidate` / `rebind` restart primitive. Its `shutdown()` is the last teardown
  phase.
- `@zakkster/lite-di-supervisor` -- the GAP-1 self-healing keystone; its `shutdown()`
  is what this package disarms before teardown.
- `@zakkster/lite-di-health` -- the GAP-4 readiness/liveness surface; its `drain()`
  is the first teardown phase.
- **`@zakkster/lite-di-orchestrator`** -- this package: the capstone that retires the
  container, supervisor, and health surface in the ratified order on `SIGTERM`.
- `@zakkster/lite-di-event-bus` -- zero-GC DI fan-out / pub-sub (sibling).
- `@zakkster/lite-di-cron` -- wall-clock scheduling over the container (sibling).
- `@zakkster/lite-di-ticker` -- the per-frame system loop, 0 B/frame (sibling).
- `@zakkster/lite-di-graph` -- topology visualization / `describe()` formatting
  (sibling).
- `@zakkster/lite-gc-profiler` / `@zakkster/lite-leak` -- the allocation gate and
  retention witness that prove the 0 B/op `phase` getter and the soak.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
