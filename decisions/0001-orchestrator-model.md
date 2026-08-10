# 0001 -- Orchestrator model: opt-in signals, ratified teardown order, exactly-once exit

- Status: ratified
- Package: @zakkster/lite-di-orchestrator 1.0.0-alpha.1
- Composes with: @zakkster/lite-di-container 2.2.0 (`shutdown()`),
  @zakkster/lite-di-supervisor 1.0.0-alpha.1 (`shutdown()`), and
  @zakkster/lite-di-health 1.0.0-alpha.1 (`drain()`) -- but needs NO dependency (not
  even a peer): the collaborators are duck-typed.
- Date: 2026-08-10

## Context

The `@zakkster/lite-di-*` line is a self-healing zero-GC backend service kernel: a
container WIRES the graph, a supervisor HEALS it, health REPORTS on it. What was
missing is the CAPSTONE -- the machine that RETIRES all three, in the right order,
when the process is asked to stop. A long-running service that catches `SIGTERM`
must drain readiness (so the load balancer stops routing) before it stops healing
(so nothing restarts mid-teardown) before it runs app cleanup before it dismantles
the container -- all under a hard deadline, and ending in exactly one process exit
with a diagnostic code.

Two lessons the sibling sessions learned the hard way drive the design. The
cron-session thenable lesson: an async collaborator can fail in hostile ways (a
`.then` getter that throws, a `shutdown()` that rejects, a phase that never settles),
and the machine must fail CLOSED -- advance and still exit, never wedge. The
health/supervisor vacuous-gate lesson: a load-bearing invariant (the order, the
exactly-once exit, the double-signal force) must be PINNED by an assertion that can
regress-FAIL, never assumed. The forks below were ratified by the user before any
code, on 2026-08-10.

## Fixed input (ratified verbatim) -- signal ownership

> Signal ownership is OPT-IN and REVERSIBLE. The constructor is PURE and INERT: it
> touches NO process global. `listen()` is the ONLY method that calls `process.on`,
> installing one handler per signal; a second install THROWS (fail closed). It
> returns an idempotent disposer that `process.off`s every signal and flips the
> armed flag back off. A library that grabs signals on import is un-embeddable and
> untestable -- it fights the host and leaks handlers across a hot reload.
> Inert-until-asked is the only composable default.

This is recorded verbatim as a FIXED INPUT (not a fork the implementation may
reopen). The constructor sets every field unconditionally for a stable hidden class
and reads nothing from `process`; the T1 torture tier pins it with a signal-listener
census that must be UNCHANGED across `new Orchestrator(...)` and across 1e4
constructions.

## The ratified forks

### Fork 1 -- Teardown ORDER (ratified)

- Options: an arbitrary/registration order, vs the fixed sequence drain ->
  supervisor.shutdown -> steps -> container.shutdown.
- Ratified: **drain -> supervisor.shutdown -> steps (in registration order) ->
  container.shutdown -> exit(code).**

```
shutdown():
  RUNNING  -> DRAINING:  if health:      health.drain()            (readyz fails; livez untouched)
  DRAINING -> STOPPING:  if supervisor:  await supervisor.shutdown()   (disarm self-healing FIRST)
                         for each step in order: await step.fn()       (graph still alive)
                         await container.shutdown()                    (reverse-topo teardown, LAST)
  STOPPING -> STOPPED:   exit(code)
```

- Justification: **drain first** so k8s stops routing while `/livez` stays up (the
  process is ALIVE during a drain -- failing livez would invite a SIGKILL
  mid-shutdown). **supervisor.shutdown BEFORE steps** so nothing self-heals
  mid-teardown; crucially `supervisor.shutdown()` only STOPS supervising -- the
  container graph is still fully constructed, so steps can still resolve and use
  services. **container LAST** because its reverse-topological teardown is the actual
  dismantling, so it runs after everything that might still need a service.
- Consequence of the wrong choice: draining late routes traffic into a dying
  process; tearing the container down before disarming the supervisor makes the
  supervisor try to RESTART the services being killed; running steps after the
  container is gone uses torn-down services. The order is the product.

### Fork 2 -- Per-phase fail-closed vs abort-on-error (ratified)

- Options: abort the sequence on the first phase that throws/rejects, vs catch each
  phase independently and continue.
- Ratified: **each phase is its own `try { await ... } catch (_e) { dirty = true; }`;
  a failing phase records DIRTY and the sequence ADVANCES.**
- Justification: a shutdown that aborted on the first error would leave the process
  half-torn-down and lingering -- the worst outcome. A synchronously-throwing
  `drain()`, a collaborator whose `shutdown()` rejects, a thenable with a throwing
  `.then` getter, or a bad step must NOT wedge the machine and must NOT skip the
  remaining phases or the exit. The teardown still finishes; the exit code carries
  the fact that something went wrong.
- Consequence of the wrong choice: fail-open (swallow silently with a clean exit)
  hides real teardown faults from an operator; abort-on-error strands the process.
  DIRTY is the honest middle -- finish the teardown, report the fault.

### Fork 3 -- The deadline: a fail-closed backstop (ratified)

- Options: no deadline (trust every phase to settle), vs a one-shot timer that
  force-exits an overrunning sequence.
- Ratified: **a single cold one-shot timer, armed before the first phase, bounds the
  WHOLE sequence; on elapse it force-exits with `EXITS.DEADLINE`.** The timer surface
  is INJECTABLE via `shutdown({ timers })` so tests drive it deterministically.
- Justification: a cleanup step that HANGS (a promise that never settles) must not
  hang the process forever -- something has to force the exit. The deadline is the
  only thing that can move a machine suspended at a hung `await`. This is NOT a hot
  path: exactly one timer per shutdown, and a shutdown runs once per process, so
  allocating a closure + a timer here is free. (Recorded explicitly because the rest
  of the DI line gates hot lanes at 0 B -- this one is deliberately cold.)
- Consequence of the wrong choice: no deadline means a single wedged phase lingers
  until the platform SIGKILLs the process -- exactly the ungraceful outcome the
  package exists to prevent.

### Fork 4 -- Exactly-once exit + double-signal FORCED (ratified)

- Options: let each path call exit however it likes, vs a single latch guaranteeing
  one exit; ignore a second signal vs force-exit on it.
- Ratified: **`exit(code)` is called EXACTLY ONCE across ALL paths (clean completion,
  deadline, double-signal), enforced by an `_exited` boolean latch every route
  checks-and-sets. A SECOND signal arriving while a shutdown is in flight (phase
  strictly between RUNNING and STOPPED) force-exits immediately with `EXITS.FORCED`,
  no waiting.**
- Justification: a shutdown that exits twice is a bug (double-cleanup, confusing exit
  codes); one that never exits is worse. The latch makes the exit a single,
  observable event. The double-signal force is the operator's escape hatch: a second
  `Ctrl-C` when a graceful shutdown is taking too long should stop NOW.
- Consequence of the wrong choice: without the latch, the deadline timer and a late
  phase completion could BOTH exit; without the force path, a stuck shutdown ignores
  the operator hammering the signal.

## Exit codes (the diagnostic contract)

| Code                 | Name     | Meaning                                                                 |
| -------------------- | -------- | ----------------------------------------------------------------------- |
| `0`                  | OK       | Every phase completed cleanly within the deadline.                      |
| `1`                  | DIRTY    | A phase threw/rejected but the sequence still finished before the deadline. |
| `2`                  | DEADLINE | The whole sequence overran `deadlineMs`; the one-shot timer force-exited. |
| `3`                  | FORCED   | A second signal arrived while a shutdown was already in flight.         |

`exit(code)` is called EXACTLY ONCE across every one of these paths.

## No hot path; T6 replaced by a soak

This is a COLD lifecycle machine: a shutdown runs ONCE per process, so the teardown
path (`step`, `listen`, `shutdown`, the phase walk) allocates freely -- there is no
steady-state frame loop to gate. The ONLY 0-allocation lane is the `phase` getter
(a single property read: no branch, no closure, no allocation), hard-gated at 0.000
B/op over 1e6 reads. Consequently the usual "T6 hot-loop budget" tier is REPLACED by
a RETENTION SOAK: 1e4 full lifecycles proving the signal-listener census returns to
baseline (no handler leak), every instance finalizes (lite-leak size 0), and the
heap delta stays under 64 KB. The deadline timer is likewise cold by design (one
one-shot timer per shutdown) and is not gated for allocation.

## Public surface

```
new Orchestrator(container, { health?, supervisor? })  // PURE + INERT; container needs shutdown(); unknown key -> did-you-mean
.step(name, fn) -> void            // COLD, append-only. name unique string|symbol; fn a function. Runs during STOPPING.
.listen({ signals=['SIGTERM','SIGINT'], exit=process.exit, force=false }) -> disposer  // the ONLY method touching process; 2nd install throws
.shutdown({ exit=process.exit, timers={setTimeout,clearTimeout}, deadlineMs=10000 }) -> Promise  // idempotent; exits exactly once
.phase -> number                   // HOT: 0.000 B/op. One of STATES.

STATES = frozen { RUNNING:0, DRAINING:1, STOPPING:2, STOPPED:3, FORCED:4 }
EXITS  = frozen { OK:0, DIRTY:1, DEADLINE:2, FORCED:3 }
VERSION -> string
```

Topology is append-only in alpha (no step removal) -- fail-closed-simpler, matching
the sibling bricks.

## Fail-closed rules (the reviewer checklist)

- `container` null / not an object / no `shutdown()` function -> `TypeError`.
- `health` present without a `drain()` function, or `supervisor` present without a
  `shutdown()` function -> `TypeError` (never a phantom collaborator).
- An unknown option key (constructor, `listen`, or `shutdown`) throws with a
  did-you-mean hint (never a silent ignore).
- An empty/non-token/duplicate step name, or a non-function step fn -> throw.
- `listen`: empty/non-string signals, a non-function `exit`, or a non-boolean
  `force` -> throw; a second install throws; the disposer is idempotent; a rejected
  `listen()` installs nothing.
- `shutdown`: a non-function `exit`, a `timers` without callable
  `setTimeout`/`clearTimeout`, or a non-positive/non-finite `deadlineMs` -> throw.
- A throwing/rejecting/hanging phase never aborts the remaining teardown and never
  wedges the machine: it records DIRTY (or triggers the DEADLINE) and ADVANCES.
- `exit(code)` is called EXACTLY ONCE across every path (latch-guarded).
- No `console.*` anywhere. ASCII-only source.

## Scope-down (NOT in 1.0.0-alpha.1)

- Step removal / dynamic deregistration (topology is append-only).
- Per-phase deadlines (only a single whole-sequence deadline).
- A built-in HTTP server / socket ownership (wire `server.close()` as a step).
- Retry / backoff of a failing phase (a phase runs once; failure -> DIRTY).
- `undrain` on abort / shutdown cancellation (a started shutdown runs to an exit).
