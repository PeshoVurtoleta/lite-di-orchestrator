// examples/service-kernel.mjs
//
// A self-healing service kernel, composed from the five @zakkster/lite-di-* modules
// this package is the capstone of. It is a RUNNABLE, SELF-VERIFYING reference app:
// every claim is asserted with node:assert/strict, so a broken contract exits
// non-zero. Run it with `npm run example` (folded into `npm run verify`, a hard
// prepublish gate).
//
// This is the wave-4 "prove them in COMPOSITION" gate-3 artifact. lock / health /
// supervisor / orchestrator are not provable in isolation -- their whole reason for
// being is the ordered, fail-closed lifecycle of ONE long-running backend service.
//
// The five collaborators (workspace-linked here as dev deps; a tarball consumer
// installs them alongside this package):
//   - @zakkster/lite-di-container    the DI graph + reverse-topological teardown
//   - @zakkster/lite-di-supervisor   OTP-style self-healing (restart on pushed fault)
//   - @zakkster/lite-di-health       fail-closed readyz/livez aggregator
//   - @zakkster/lite-di-lock         a fencing lease for a leader-only critical section
//   - @zakkster/lite-di-orchestrator the SIGTERM graceful-shutdown capstone (this pkg)
//
// The narrative is one service lifecycle: BOOT -> run a lock-guarded reconcile ->
// take a fault and SELF-HEAL -> prove the restart budget fails closed -> prove every
// construction guard fails closed -> catch "SIGTERM" and drain in the RIGHT order.
//
// ASCII-only. Imports limited to @zakkster/* + node: builtins. No console.*.

import assert from 'node:assert/strict';
import { Container } from '@zakkster/lite-di-container';
import {
  Supervisor, STRATEGIES, STATES as SUP, VERSION as SUP_VERSION,
} from '@zakkster/lite-di-supervisor';
import {
  Health, LANES, STATES as HEALTH, VERSION as HEALTH_VERSION,
} from '@zakkster/lite-di-health';
import {
  Lock, MemoryStore, bindLock, STATES as LOCK, REASONS, VERSION as LOCK_VERSION,
} from '@zakkster/lite-di-lock';
import {
  Orchestrator, STATES as ORCH, EXITS, VERSION as ORCH_VERSION,
} from '@zakkster/lite-di-orchestrator';

const out = (s) => process.stdout.write(s + '\n');
const banner = (s) => out('\n--- ' + s + ' ---');

// Tolerates BOTH a synchronous throw and a rejected promise. Some fail-closed
// guards throw synchronously (e.g. Supervisor.reportFault validates before its async
// restart path), so a plain assert.rejects -- which fails on a sync throw -- is the
// wrong tool. This is exactly how a real caller (and run() internally) guards them.
const throwsAsync = async (fn, label) => {
  let threw = false;
  try { await fn(); } catch (e) { threw = true; }
  assert.ok(threw, label + ': expected a throw or rejection');
};

// Inert but ARMABLE timers: no real timer fires during the run (the heartbeat path
// is exercised explicitly via tick()), yet setTimeout returns a truthy handle so the
// lock never trips its TIMER_UNARMABLE guard.
const inertTimers = { setTimeout: () => 1, clearTimeout: () => {} };

// Container-teardown taps push here ONLY during the final drain (section 6); a null
// sink makes them no-ops during the section-3 heal, which also fires onTeardown.
let orderSink = null;
const tapTeardown = (tag) => () => { if (orderSink) orderSink.push(tag); };

// The service graph: db <- cache <- api. A runtime break flips db.broken so query()
// throws; the supervisor rebuilds the whole chain against a fresh db.
class Db {
  constructor(config) {
    this.config = config;
    this.connected = true;
    this.broken = false;
    this.id = ++Db.built;
  }
  query() {
    if (this.broken) throw new Error('db: connection lost');
    return 'ok';
  }
}
Db.built = 0;

class Cache {
  constructor(db) { this.db = db; this.warm = true; this.id = ++Cache.built; }
}
Cache.built = 0;

class Api {
  constructor(cache) { this.cache = cache; this.id = ++Api.built; }
  serve() { return 'served:' + this.cache.db.query(); }
}
Api.built = 0;

async function main() {
  // ---- module surface: every module exports a three-place VERSION string ----
  banner('module surface');
  for (const [name, v] of [
    ['supervisor', SUP_VERSION], ['health', HEALTH_VERSION],
    ['lock', LOCK_VERSION], ['orchestrator', ORCH_VERSION],
  ]) {
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0, name + ' VERSION non-empty');
    out('  ' + name + ' v' + v);
  }

  // ================================================================
  // 1. BOOT THE KERNEL: container graph + supervisor + health
  // ================================================================
  banner('1. boot the service kernel');

  const c = new Container();
  c.value('config', { dsn: 'memory://orders' });
  c.singleton('db', Db, ['config']);
  c.singleton('cache', Cache, ['db']);
  c.singleton('api', Api, ['cache']);
  // Teardown taps prove the container is dismantled LAST (see section 6).
  c.onTeardown('db', tapTeardown('teardown:db'));
  c.onTeardown('cache', tapTeardown('teardown:cache'));
  c.onTeardown('api', tapTeardown('teardown:api'));

  // A leader-only reconcile lock, BOUND so it retires through container.shutdown()
  // (bindLock registers a singletonFactory + onTeardown -- must be pre-boot).
  const reconcileStore = new MemoryStore();
  const leaderLock = new Lock(c, {
    store: reconcileStore, key: 'reconcile:orders', ttlMs: 30000, timers: inertTimers,
  });
  bindLock(c, 'reconciler-lock', leaderLock);

  c.boot();

  const sup = new Supervisor(c, {
    children: ['db', 'cache', 'api'],       // declared START order
    strategy: STRATEGIES.REST_FOR_ONE,      // fault db -> rebuild db + cache + api
    maxRestarts: 3,
    windowMs: 5000,
    onRestart: (info) => out(
      '  [supervisor] restarted ' + String(info.token) + ' (' + info.strategy + ')'),
  });
  await sup.start();

  const health = new Health({
    sources: [{ name: 'proc', probe: () => true, lane: LANES.LIVE }],  // event loop turns
  });
  health.watchSupervisor('kernel', sup, LANES.READY);                  // 0 healthy -> ready
  health.source('db', () => (c.get('db').connected === true ? 0 : 1), LANES.READY);
  health.source('cache', () => (c.get('cache').warm === true ? 0 : 1), LANES.BOTH);

  assert.equal(sup.check(), 0, 'all children healthy at boot');
  assert.equal(health.readyz(), 0, 'ready at boot');
  assert.equal(health.livez(), 0, 'live at boot');
  assert.equal(sup.state, SUP.RUNNING);
  assert.equal(health.state, HEALTH.OK);
  const report = health.report();
  assert.equal(report.ready, 0);
  assert.equal(report.live, 0);
  assert.ok(report.sources.some((s) => s.name === 'db' && s.status === 'healthy'),
    'report() shows db healthy');
  out('  booted: ' + report.sources.length + ' health sources, all green');

  // ================================================================
  // 2. LEADER-ONLY CRITICAL SECTION: a fencing lease
  // ================================================================
  banner('2. leader-only reconcile (fencing lock)');

  // Resolve the bound lock (caches it, so container.shutdown() will dispose it).
  const boundLock = c.get('reconciler-lock');
  assert.equal(boundLock, leaderLock, 'bindLock resolves the same instance');

  // RAII: acquire -> fenced child scope -> body -> release, all fail-closed.
  let fencedRan = false;
  let seenFence = 0;
  const runResult = await leaderLock.run((scope) => {
    fencedRan = true;
    seenFence = scope.get('lock:fence');   // guaranteed integer >= 1, or the body never runs
    return leaderLock.fencingToken;
  });
  assert.ok(fencedRan, 'fenced body ran');
  assert.ok(Number.isInteger(seenFence) && seenFence >= 1, 'fence is an integer >= 1');
  assert.equal(runResult, seenFence, 'run() returns the body value');
  assert.equal(leaderLock.held, false, 'lease released after run()');
  out('  reconcile ran under fence ' + seenFence + ', lease released');

  // Mutual exclusion over a SHARED store: only one holder at a time; the fence advances.
  const shared = new MemoryStore();
  const holderA = new Lock(c, { store: shared, key: 'leader', ttlMs: 30000, timers: inertTimers });
  const holderB = new Lock(c, { store: shared, key: 'leader', ttlMs: 30000, timers: inertTimers });
  assert.equal(await holderA.acquire(), true, 'A acquires');
  assert.equal(holderA.held, true);
  assert.equal(await holderB.acquire(), false, 'B is denied while A holds (fail closed)');
  assert.equal(holderB.state, LOCK.IDLE, 'B stays IDLE -- no phantom lock');
  assert.equal(holderB.fencingToken, 0, 'B has no fence');
  // B.run() while A holds -> NotAcquired; the body never runs unfenced.
  let bBodyRan = false;
  await throwsAsync(
    () => holderB.run(() => { bBodyRan = true; }),
    'B.run rejects when it cannot acquire');
  assert.equal(bBodyRan, false, 'B body never ran unfenced');
  // A releases; B now acquires with a HIGHER fence (monotonic).
  const aFence = holderA.fencingToken;
  assert.ok(aFence >= 1);
  assert.equal(await holderA.release(), true, 'A releases');
  assert.equal(await holderB.acquire(), true, 'B acquires after A released');
  assert.ok(holderB.fencingToken > aFence, 'B fence advanced past A');
  out('  mutual exclusion held; fence advanced ' + aFence + ' -> ' + holderB.fencingToken);

  // Headless heartbeat: tick() renews while HELD (the timer path, driven explicitly).
  assert.equal(await holderB.tick(), true, 'tick renews a held lease');
  assert.equal(holderB.held, true);

  // Fail-closed heartbeat: a renew that is not strict true loses the lease to LOST,
  // fires onLost EXACTLY once, and never touches the store again.
  let lostReason = null;
  let lostCount = 0;
  const flakyStore = {
    acquire: async () => ({ ok: true, token: 1 }),
    renew: async () => false,               // anything but strict true
    release: async () => true,
  };
  const flaky = new Lock(c, {
    store: flakyStore, key: 'flaky', ttlMs: 30000, timers: inertTimers,
    onLost: (reason) => { lostCount += 1; lostReason = reason; },
  });
  assert.equal(await flaky.acquire(), true);
  assert.equal(await flaky.tick(), false, 'a non-true renew loses the lease');
  assert.equal(flaky.state, LOCK.LOST, 'state is LOST');
  assert.equal(lostReason, REASONS.HEARTBEAT_FAILED, 'onLost reason is HEARTBEAT_FAILED');
  assert.equal(await flaky.tick(), false, 'tick after LOST is inert');
  assert.equal(lostCount, 1, 'onLost fired exactly once');
  out('  heartbeat failed closed -> LOST (HEARTBEAT_FAILED), onLost once');

  // acquire() is non-reentrant (throws from HELD); run() rejects a non-function fn
  // before it ever touches the store.
  await throwsAsync(() => holderB.acquire(), 'acquire is non-reentrant from HELD');
  await throwsAsync(() => holderA.run(123), 'run() rejects a non-function fn');

  // dispose() is an idempotent terminal.
  await holderA.dispose();
  await holderB.dispose();
  await flaky.dispose();
  await flaky.dispose();                    // idempotent
  assert.equal(holderB.held, false);

  // ================================================================
  // 3. FAULT AND SELF-HEAL: push a fault, supervisor rebuilds the tree
  // ================================================================
  banner('3. fault injection + self-heal');

  // A healthy run passes the value straight through.
  assert.equal(await sup.run('api', () => c.get('api').serve()), 'served:ok');

  // A subsystem breaks at runtime. Health POLLS and sees it immediately; the
  // supervisor is PUSH-based and does NOT act until a fault is reported.
  const oldDb = c.get('db');
  oldDb.connected = false;
  oldDb.broken = true;
  assert.notEqual(health.readyz(), 0, 'health (poll) sees the broken db');
  assert.equal(sup.check(), 0, 'supervisor (push) has NOT been told yet');
  out('  db broke: readyz=' + health.readyz() + ' (health saw it), sup.check='
    + sup.check() + ' (not yet told)');

  // Report the fault via run(): the ORIGINAL error is re-thrown to the caller, and
  // rest-for-one rebuilds db + cache + api against fresh deps.
  let propagated = null;
  try {
    await sup.run('db', () => c.get('db').query());
  } catch (e) {
    propagated = e.message;
  }
  assert.equal(propagated, 'db: connection lost', 'run() re-throws the ORIGINAL error');

  const newDb = c.get('db');
  assert.notEqual(newDb, oldDb, 'db was rebuilt to a fresh instance');
  assert.equal(newDb.connected, true, 'the fresh db is healthy');
  assert.equal(c.get('cache').db, newDb, 'cache rebound to the fresh db (rest-for-one)');
  assert.equal(sup.check(), 0, 'supervisor reports healthy after heal');
  assert.equal(health.readyz(), 0, 'health ready after heal');
  out('  self-healed: db#' + oldDb.id + ' -> db#' + newDb.id
    + ', cache + api rebuilt, all green');

  // ================================================================
  // 4. RESTART BUDGET FAILS CLOSED: escalate, never hot-loop
  // ================================================================
  banner('4. restart-budget escalation');

  const ec = new Container();
  ec.singleton('worker', class {});
  ec.boot();
  let escalations = 0;
  let escInfo = null;
  let restarts = 0;
  const esup = new Supervisor(ec, {
    children: ['worker'],
    strategy: STRATEGIES.ONE_FOR_ONE,
    maxRestarts: 2,
    windowMs: 5000,
    now: () => 1000,                        // fixed clock -> a deterministic budget
    onRestart: () => { restarts += 1; },
    onEscalate: (info) => { escalations += 1; escInfo = info; },
  });
  await esup.start();
  await esup.reportFault('worker');         // restart 1/2
  await esup.reportFault('worker');         // restart 2/2
  assert.equal(restarts, 2);
  assert.equal(esup.state, SUP.RUNNING);
  await esup.reportFault('worker');         // 3rd within the window -> ESCALATE
  assert.equal(escalations, 1, 'escalated exactly once');
  assert.equal(esup.state, SUP.ESCALATED, 'terminal ESCALATED, not a hot loop');
  assert.equal(String(escInfo.token), 'worker');
  assert.equal(escInfo.windowMs, 5000);
  await throwsAsync(() => esup.reportFault('worker'),
    'reportFault after escalate is refused');
  await esup.shutdown();
  await ec.shutdown();
  out('  budget exhausted -> onEscalate once, further faults refused');

  // one-for-all: a fault in ANY child rebuilds EVERY child against fresh deps.
  const ac = new Container();
  let na = 0;
  let nb = 0;
  ac.singleton('a', class { constructor() { this.id = ++na; } });
  ac.singleton('b', class { constructor() { this.id = ++nb; } });
  ac.boot();
  const a0 = ac.get('a');
  const b0 = ac.get('b');
  const asup = new Supervisor(ac, { children: ['a', 'b'], strategy: STRATEGIES.ONE_FOR_ALL });
  await asup.start();
  await asup.reportFault('a');
  assert.notEqual(ac.get('a'), a0, 'one-for-all rebuilt the faulted child');
  assert.notEqual(ac.get('b'), b0, 'one-for-all ALSO rebuilt the sibling');
  await asup.shutdown();
  await ac.shutdown();
  out('  one-for-all: a fault in one child rebuilt every child');

  // ================================================================
  // 5. FAIL-CLOSED CONSTRUCTION GUARDS (every module rejects bad wiring)
  // ================================================================
  banner('5. fail-closed construction guards');

  const rejects = (fn, re, label) => {
    let msg = null;
    try { fn(); } catch (e) { msg = e.message; }
    assert.ok(msg !== null, label + ': expected a throw');
    assert.match(msg, re, label);
  };

  // health
  rejects(() => { const h = new Health(); h.source('x', () => true); h.source('x', () => true); },
    /duplicate source name 'x'/, 'health duplicate name');
  rejects(() => { const h = new Health(); h.source('y', 123); },
    /probe for 'y' must be a function/, 'health non-function probe');
  rejects(() => { const h = new Health(); h.watchSupervisor('s', null); },
    /must be an object exposing a check\(\) method/, 'health watchSupervisor null');
  // lock
  rejects(() => new Lock(c, { ttlMs: 1000 }),
    /key must be a non-empty string or a symbol/, 'lock missing key');
  rejects(() => new Lock(c, { key: 'k', ttlMs: 0 }),
    /ttlMs must be a finite number > 0/, 'lock bad ttl');
  rejects(() => new Lock({}, { key: 'k', ttlMs: 1000 }),
    /container must be an object with scope\(\)/, 'lock bad container');
  rejects(() => new Lock(c, { key: 'k', ttlMs: 1000, store: { acquire() {}, release() {} } }),
    /store is missing a required 'renew\(\)' method/, 'lock store missing renew');
  rejects(() => new Lock(c, { key: 'k', ttlMs: 1000, bogus: 1 }),
    /unknown option 'bogus'/, 'lock unknown option');
  rejects(() => new Lock(c, { key: 'k', ttlMs: 1000, heartbeatMs: 900 }),
    /heartbeatMs\*2 must be <= ttlMs/, 'lock heartbeat ratio');
  // supervisor
  rejects(() => new Supervisor(c, { children: ['db'], strategy: 'nope' }),
    /unknown strategy 'nope'/, 'supervisor unknown strategy');
  rejects(() => new Supervisor(c, { children: [] }),
    /children must be a non-empty array/, 'supervisor empty children');
  // orchestrator
  rejects(() => new Orchestrator({}),
    /container must be an object with a shutdown\(\) method/, 'orchestrator bad container');
  rejects(() => new Orchestrator(c, { health: {} }),
    /health must be an object with a drain\(\) method/, 'orchestrator health missing drain');
  rejects(() => new Orchestrator(c, { supervisor: {} }),
    /supervisor must be an object with a shutdown\(\) method/, 'orchestrator supervisor missing shutdown');
  rejects(() => { const o = new Orchestrator(c); o.step('s', 5); },
    /fn for 's' must be a function/, 'orchestrator non-function step');
  out('  15 construction guards all fail closed');

  // Fail-closed coercion: a THROWING probe is UNHEALTHY but never aborts the sweep;
  // an empty lane is not-ready (nothing has vouched for it).
  const hc = new Health();
  hc.source('boom', () => { throw new Error('probe blew up'); }, LANES.READY);
  hc.source('also-bad', () => 1, LANES.READY);      // non-zero -> unhealthy
  assert.equal(hc.readyz(), 2, 'sweep continued past the throw (both counted, not just the first)');
  const emptyLane = new Health();
  emptyLane.source('only-ready', () => true, LANES.READY);
  assert.equal(emptyLane.livez(), 1, 'empty LIVE lane fails closed (not live)');
  out('  coercion: a throwing probe is unhealthy but the sweep continues; empty lane = not-ready');

  // drain() is reversible via undrain() (only the SIGTERM path leaves it latched).
  const rh = new Health();
  rh.source('svc', () => true, LANES.READY);
  rh.drain();
  assert.notEqual(rh.readyz(), 0, 'drain() latches not-ready');
  rh.undrain();
  assert.equal(rh.readyz(), 0, 'undrain() restores ready');
  out('  drain()/undrain() is reversible');

  // Per-phase fail-closed: a throwing step records a DIRTY exit and ADVANCES; later
  // steps still run and the container is still torn down.
  const dc = new Container();
  dc.singleton('svc', class {});
  let dcTornDown = false;
  dc.onTeardown('svc', () => { dcTornDown = true; });
  dc.boot();
  dc.get('svc');                                    // cache so teardown fires
  const dorch = new Orchestrator(dc);
  let laterStepRan = false;
  dorch.step('bad', () => { throw new Error('cleanup failed'); });
  dorch.step('good', () => { laterStepRan = true; });
  let dirtyCode = null;
  await dorch.shutdown({ exit: (code) => { dirtyCode = code; }, deadlineMs: 5000 });
  assert.equal(dirtyCode, EXITS.DIRTY, 'a throwing step -> DIRTY exit');
  assert.ok(laterStepRan, 'the later step ran despite the earlier throw');
  assert.ok(dcTornDown, 'the container was still torn down after a dirty step');
  out('  dirty step -> EXITS.DIRTY, teardown advanced (later step + container ran)');

  // A deadline that cannot even be armed fails closed to DEADLINE at once (a hung
  // phase is bounded by the timer, never by a hang) -- exit once, promise still resolves.
  const deadlineExits = [];
  const throwingTimers = { setTimeout() { throw new Error('cannot arm deadline'); }, clearTimeout() {} };
  await new Orchestrator({ async shutdown() {} }, { health: { drain() {} } })
    .shutdown({ exit: (code) => deadlineExits.push(code), timers: throwingTimers, deadlineMs: 1000 });
  assert.deepEqual(deadlineExits, [EXITS.DEADLINE], 'an unarmable deadline -> EXITS.DEADLINE, exactly once');
  out('  deadline path -> EXITS.DEADLINE (bounded, exit once)');

  // The signal seam: listen() is the ONLY method touching process, and it is
  // reversible. (SIGUSR2 chosen so the test runner's SIGTERM/SIGINT are untouched.)
  const lc = new Container();
  lc.boot();
  const lorch = new Orchestrator(lc);
  const base = process.listenerCount('SIGUSR2');
  const stop = lorch.listen({ signals: ['SIGUSR2'], exit: () => {} });
  assert.equal(process.listenerCount('SIGUSR2'), base + 1, 'listen installs one handler');
  assert.throws(() => lorch.listen({ signals: ['SIGUSR2'], exit: () => {} }),
    'a second listen throws');
  stop();
  assert.equal(process.listenerCount('SIGUSR2'), base, 'the disposer removes the handler');
  stop();                                           // idempotent
  assert.equal(process.listenerCount('SIGUSR2'), base, 'the disposer is idempotent');
  await lc.shutdown();
  out('  listen() installs + reverses cleanly; a second listen is refused');

  // ================================================================
  // 6. GRACEFUL SIGTERM: drain -> disarm healing -> steps -> teardown
  // ================================================================
  banner('6. graceful shutdown (the capstone)');

  const order = [];
  // Tap the two collaborator calls the orchestrator drives. Reading livez/readyz AT
  // the drain moment (container still alive) captures the k8s invariant precisely:
  // readiness drains, liveness stays up.
  let livezAtDrain = null;
  let readyzAtDrain = null;
  const realDrain = health.drain.bind(health);
  health.drain = () => {
    order.push('drain');
    const r = realDrain();
    livezAtDrain = health.livez();      // liveness is UNAFFECTED by drain
    readyzAtDrain = health.readyz();    // readiness is now latched not-ready
    return r;
  };
  const realSupShutdown = sup.shutdown.bind(sup);
  sup.shutdown = () => { order.push('supervisor:shutdown'); return realSupShutdown(); };

  // The leader lock must enter container.shutdown() in a NON-terminal state: a HELD
  // lease is released by nothing else, so reaching RELEASED afterward PROVES the
  // container disposed it (via bindLock). Also tap its disposal into the order log.
  assert.equal(await leaderLock.acquire(), true, 're-acquire the leader lease');
  assert.equal(leaderLock.held, true, 'leader lock is HELD entering shutdown');
  const realLockDispose = leaderLock.dispose.bind(leaderLock);
  leaderLock.dispose = () => {
    if (orderSink) orderSink.push('teardown:lock');
    return realLockDispose();
  };

  const orch = new Orchestrator(c, { health, supervisor: sup });
  let graphAliveInStep = false;
  orch.step('close-listener', () => { order.push('step:close-listener'); });
  orch.step('flush-metrics', () => {
    order.push('step:flush-metrics');
    graphAliveInStep = c.get('db').connected === true;   // graph still constructed here
  });

  assert.equal(orch.phase, ORCH.RUNNING);
  orderSink = order;                     // container-teardown taps now record

  let exitCode = null;
  let exitCalls = 0;
  const shutdownOpts = { exit: (code) => { exitCalls += 1; exitCode = code; }, deadlineMs: 8000 };
  const p = orch.shutdown(shutdownOpts);
  assert.equal(orch.shutdown(shutdownOpts), p, 'shutdown() is idempotent (same promise)');
  await p;
  orderSink = null;

  // Ordered teardown: drain FIRST, supervisor BEFORE steps, container LAST.
  assert.equal(order[0], 'drain', 'drain runs first (bleed traffic)');
  assert.equal(order[1], 'supervisor:shutdown', 'supervisor disarmed before steps');
  assert.equal(order[2], 'step:close-listener', 'steps run in registration order');
  assert.equal(order[3], 'step:flush-metrics');
  const firstTeardown = order.findIndex((t) => t.indexOf('teardown:') === 0);
  assert.ok(firstTeardown > 3, 'the container was dismantled AFTER the steps (last)');
  for (const tok of ['teardown:db', 'teardown:cache', 'teardown:api']) {
    assert.ok(order.includes(tok), tok + ' fired during container.shutdown');
  }
  assert.ok(graphAliveInStep, 'the graph was still alive during the steps');

  // Liveness stays up while readiness drains (k8s keeps the pod, stops routing).
  assert.equal(livezAtDrain, 0, 'livez stayed LIVE throughout the drain');
  assert.notEqual(readyzAtDrain, 0, 'readyz drained (not ready)');
  assert.equal(health.state, HEALTH.DRAINING, 'health latched DRAINING (never undrained on SIGTERM)');

  // The lock retired through the container it was bound into (bindLock): a HELD lease
  // reaches RELEASED ONLY via the container-driven dispose(), and that disposal lands
  // in the container phase (after the steps).
  assert.ok(order.includes('teardown:lock'), 'the leader lock was disposed during container.shutdown');
  assert.ok(order.indexOf('teardown:lock') > 3, 'the lock was disposed in the container phase (after steps)');
  assert.equal(leaderLock.held, false, 'leader lock no longer HELD after teardown');
  assert.equal(leaderLock.state, LOCK.RELEASED,
    'a HELD lock reaches RELEASED only via container-driven dispose()');

  // Exactly one exit, clean, terminal states everywhere.
  assert.equal(exitCalls, 1, 'exit called EXACTLY once');
  assert.equal(exitCode, EXITS.OK, 'a clean shutdown -> EXITS.OK');
  assert.equal(orch.phase, ORCH.STOPPED);
  assert.equal(sup.state, SUP.SHUT_DOWN);

  out('  drain -> supervisor.shutdown -> steps -> container (lock disposed) -> exit(OK), once');
  out('  order: ' + order.join(' -> '));

  banner('reference app: OK');
}

main().catch((err) => {
  process.stdout.write(
    '\nreference app: FAILED\n' + (err && err.stack ? err.stack : String(err)) + '\n');
  process.exit(1);
});
