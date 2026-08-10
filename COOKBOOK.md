# Cookbook -- @zakkster/lite-di-orchestrator

Recipes, beginner to pro. Every snippet runs against the real Orchestrator API:
`step(name, fn)`, `listen(options?)`, `shutdown(options?)`, `phase`, and the
`STATES` / `EXITS` constants.

The one rule under everything: shutdown runs ONE ratified order --
`health.drain()` -> `supervisor.shutdown()` -> steps in order ->
`container.shutdown()` -> `exit(code)` -- each phase caught on its own, and
`exit(code)` is called EXACTLY ONCE. The constructor is inert; `listen()` is the
only thing that touches `process`.

## 1. The minimum -- a container and a programmatic shutdown

An Orchestrator needs only a `container` (anything with a `shutdown()` method).
Drive the teardown yourself with an injected `exit` so nothing kills the process:

```javascript
import { Orchestrator, EXITS } from '@zakkster/lite-di-orchestrator';

const orch = new Orchestrator(container);

const code = await new Promise((resolve) => {
  orch.shutdown({ exit: resolve });   // resolves with the exit code
});
console.log(code === EXITS.OK ? 'clean' : 'code ' + code);
```

`shutdown()` is IDEMPOTENT: call it twice and you get the SAME promise back, and
`exit` still fires exactly once.

## 2. App cleanup steps -- close what the container does not own

A `step` runs during teardown while the container graph is STILL fully constructed
(after the supervisor is disarmed, before the container is dismantled), so a step
can resolve and use services. Steps run in registration order.

```javascript
const orch = new Orchestrator(container, { health, supervisor });

orch.step('stop-accepting', () => server.close());      // stop new connections
orch.step('drain-queue',    async () => queue.drain()); // finish in-flight work
orch.step('flush-metrics',  () => metrics.flush());     // last telemetry push

// order at shutdown:
//   health.drain() -> supervisor.shutdown()
//   -> stop-accepting -> drain-queue -> flush-metrics
//   -> container.shutdown() -> exit(code)
```

A step name must be a unique non-empty string or symbol; a duplicate throws. A
step that throws or rejects does NOT abort the rest -- it records a DIRTY exit and
the teardown continues (see recipe 6).

## 3. k8s /readyz + /livez wiring with drain-on-SIGTERM

The point of draining FIRST: on SIGTERM you want the load balancer to stop routing
new traffic (`/readyz` fails) while `/livez` stays up so the orchestrator does NOT
SIGKILL you mid-shutdown. `health.drain()` does exactly that, and the Orchestrator
pulls it as the first phase.

```javascript
import { Health, LANES } from '@zakkster/lite-di-health';
import { Orchestrator } from '@zakkster/lite-di-orchestrator';

const health = new Health();
health.source('proc', () => true,          LANES.LIVE);   // liveness: at least one!
health.source('db',   () => pool.connected, LANES.READY);

app.get('/livez',  (_q, r) => r.status(health.livez()  === 0 ? 200 : 503).end());
app.get('/readyz', (_q, r) => r.status(health.readyz() === 0 ? 200 : 503).end());

const orch = new Orchestrator(container, { health, supervisor });
orch.step('close-http', () => new Promise((res) => server.close(res)));

orch.listen();   // trap SIGTERM + SIGINT
// SIGTERM -> readyz starts returning 503 (drain) while livez stays 200,
//            then supervisor.shutdown(), then close-http, then container.shutdown(),
//            then process.exit(0).
```

## 4. Owning signals with listen(), and giving them back

`listen()` is the ONLY method that touches `process`. It installs one handler per
signal and returns an idempotent disposer that removes every one. A second
`listen()` while installed THROWS (fail closed) -- you never double-arm.

```javascript
const stop = orch.listen({ signals: ['SIGTERM', 'SIGINT'] });

// later -- in a test, a hot reload, or an embedded host that manages its own signals:
stop();          // process.off's every handler; idempotent (safe to call twice)
```

Because the constructor is inert, an Orchestrator is safe to build in a library or
a test without ever grabbing a signal. Nothing happens until you call `listen()`.

## 5. Programmatic shutdown with a no-op exit (tests + embedded hosts)

Injecting `exit` lets you run the whole sequence WITHOUT terminating the process --
essential for tests and for embedding inside a larger host that owns the real exit.

```javascript
let exitCode = -1;
await orch.shutdown({ exit: (code) => { exitCode = code; } });
assert.equal(exitCode, EXITS.OK);
assert.equal(orch.phase, STATES.STOPPED);
```

Inject `timers` too to make the deadline deterministic (no real clock):

```javascript
let fired = null;
const timers = {
  setTimeout: (cb) => { fired = cb; return 1; },   // capture, do not schedule
  clearTimeout: () => { fired = null; },
};
const p = orch.shutdown({ exit: onExit, timers, deadlineMs: 5000 });
// ...if a phase hangs, call fired() to simulate the deadline elapsing.
```

## 6. Reading the exit code -- OK, DIRTY, DEADLINE, FORCED

The exit code is the diagnostic. Wire it to your logs or your process exit:

```javascript
orch.shutdown({
  exit: (code) => {
    if (code === EXITS.OK)       log.info('shutdown clean');
    else if (code === EXITS.DIRTY)    log.warn('shutdown finished with phase errors');
    else if (code === EXITS.DEADLINE) log.error('shutdown overran the deadline');
    else if (code === EXITS.FORCED)   log.error('shutdown forced by a second signal');
    process.exit(code);
  },
});
```

- `OK (0)` -- every phase completed cleanly within the deadline.
- `DIRTY (1)` -- a phase threw/rejected (a bad step, a rejecting collaborator) but
  the sequence still finished in time. The teardown never aborts on one bad phase.
- `DEADLINE (2)` -- the whole sequence overran `deadlineMs`; a one-shot timer
  force-exited. A HUNG phase (a promise that never settles) is caught here, not by a
  hang.
- `FORCED (3)` -- a SECOND signal arrived while a shutdown was already in flight;
  the machine exits immediately without waiting.

## 7. Deadline tuning

`deadlineMs` (default 10000) bounds the WHOLE sequence, not a single phase. Set it
just under your orchestrator's kill grace period (k8s `terminationGracePeriodSeconds`)
so you exit cleanly before you are SIGKILLed:

```javascript
// k8s terminationGracePeriodSeconds: 30 -> leave headroom, deadline at 25s.
orch.listen();                                  // listen() uses the default 10000ms...
// ...or drive shutdown yourself for a custom deadline:
process.on('SIGTERM', () => orch.shutdown({ deadlineMs: 25000 }));
```

If a phase is slow but not hung, a generous deadline lets it finish (OK/DIRTY); if a
phase truly wedges, the deadline guarantees you still exit (DEADLINE) instead of
lingering until the platform SIGKILLs you.

## 8. Composing the whole suite

The Orchestrator is the capstone: it retires a container, a supervisor, and a
health surface in the right order. Everything is duck-typed, so the real bricks fit
natively and so does anything matching their shapes.

```javascript
import { Container } from '@zakkster/lite-di-container';
import { Supervisor } from '@zakkster/lite-di-supervisor';
import { Health, LANES } from '@zakkster/lite-di-health';
import { Orchestrator } from '@zakkster/lite-di-orchestrator';

const c = new Container();
c.singleton('db', Db);
c.singleton('cache', Cache, ['db']);
c.boot();

const sup = new Supervisor(c, { children: ['db', 'cache'] });
await sup.start();

const health = new Health();
health.watchSupervisor('kernel', sup, LANES.READY);   // supervisor -> readiness
health.source('proc', () => true, LANES.LIVE);         // at least one LIVE source

const orch = new Orchestrator(c, { health, supervisor: sup });
orch.step('close-http', () => new Promise((r) => server.close(r)));
orch.listen();

// SIGTERM ->
//   health.drain()        readyz 503, livez 200 (k8s stops routing, keeps you alive)
//   sup.shutdown()        self-healing disarmed (nothing restarts mid-teardown)
//   close-http            in-flight requests finish; new ones already refused
//   c.shutdown()          reverse-topo teardown: cache before db
//   process.exit(0)       EXITS.OK
```

## 9. Watching the phase

`phase` is a 0-allocation getter -- read it as often as you like (a supervisor loop,
an admin endpoint, a test):

```javascript
import { STATES } from '@zakkster/lite-di-orchestrator';

orch.phase === STATES.RUNNING;    // nominal
// during a shutdown it advances RUNNING -> DRAINING -> STOPPING -> STOPPED
// (or -> FORCED if a second signal forces an immediate exit).
```
