// test/shutdown.test.js -- shutdown(options?) boundary matrix: idempotency
// (same promise), RE-ENTRANCY (a synchronous collaborator that calls
// shutdown() again), ordered teardown, every exit code (OK/DIRTY/DEADLINE/
// FORCED), the exactly-once exit latch, deadlineMs validation, and the
// no-unhandled-rejection proof across the throwing-setTimeout fail-closed
// path. Traced to decisions/0001-orchestrator-model.md Forks 1-4 and the
// "Fail-closed rules" checklist.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator, STATES, EXITS } from '../Orchestrator.js';

const HOISTED_ERR = new Error('shutdown.test.js: injected phase failure');

function makeFakeTimers() {
    const state = { cb: null, ms: 0, armed: false, cleared: false, fired: false };
    return {
        state,
        timers: {
            setTimeout(cb, ms) {
                state.cb = cb; state.ms = ms; state.armed = true;
                state.cleared = false; state.fired = false;
                return 1;
            },
            clearTimeout() { state.cleared = true; },
        },
        fire() { if (state.cb !== null) { state.fired = true; state.cb(); } },
    };
}

function makeRecorder(opts) {
    const o = opts === undefined ? {} : opts;
    const calls = [];
    const container = {
        shutdown() {
            calls.push('container');
            return o.containerResult !== undefined ? o.containerResult() : Promise.resolve();
        },
    };
    const health = {
        drain() {
            calls.push('drain');
            if (o.drainThrows === true) throw HOISTED_ERR;
        },
    };
    const supervisor = {
        shutdown() {
            calls.push('supervisor');
            return o.supervisorResult !== undefined ? o.supervisorResult() : Promise.resolve();
        },
    };
    return { calls, container, health, supervisor };
}

describe('shutdown: idempotency (same promise, exit exactly once)', () => {
    test('two synchronous shutdown() calls return the SAME promise', () => {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container);
        const ft = makeFakeTimers();
        const p1 = o.shutdown({ exit: () => {}, timers: ft.timers, deadlineMs: 1000 });
        const p2 = o.shutdown({ exit: () => {}, timers: ft.timers, deadlineMs: 1000 });
        assert.equal(p1, p2);
    });

    test('a THIRD call after completion still returns the same promise; exit fired exactly once', async () => {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container);
        const ft = makeFakeTimers();
        const exits = [];
        const p1 = o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        await p1;
        const p2 = o.shutdown({ exit: (c) => exits.push(c) });
        await p2;
        assert.equal(p1, p2);
        assert.deepEqual(exits, [EXITS.OK]);
    });

    test('N (5) redundant shutdown() calls in a burst all return the same promise, exit exactly once', async () => {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container);
        const ft = makeFakeTimers();
        const exits = [];
        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 }));
        }
        for (const p of promises) assert.equal(p, promises[0]);
        await Promise.all(promises);
        assert.deepEqual(exits, [EXITS.OK]);
    });
});

describe('shutdown: RE-ENTRANCY (a synchronous collaborator calling shutdown() again)', () => {
    test('a health.drain() that calls shutdown() once gets the SAME promise back; teardown runs ONCE '
        + 'in order drain,supervisor,container', async () => {
        const rec = makeRecorder();
        let o;
        let reentered = false;
        let reentrantReturn = null;
        const health = {
            drain() {
                rec.calls.push('drain');
                if (!reentered) {
                    reentered = true;
                    reentrantReturn = o.shutdown({ exit: () => {}, timers: makeFakeTimers().timers });
                }
            },
        };
        o = new Orchestrator(rec.container, { health, supervisor: rec.supervisor });
        const ft = makeFakeTimers();
        const exits = [];
        const p1 = o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        await p1;

        assert.deepEqual(rec.calls, ['drain', 'supervisor', 'container']);
        assert.equal(reentrantReturn, p1);
        assert.deepEqual(exits, [EXITS.OK]);
    });
});

describe('shutdown: ordered teardown (drain -> supervisor -> steps -> container)', () => {
    test('a full topology runs in the exact ratified order', async () => {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        o.step('a', () => rec.calls.push('step:a'));
        o.step('b', () => rec.calls.push('step:b'));
        const ft = makeFakeTimers();
        await o.shutdown({ exit: () => {}, timers: ft.timers, deadlineMs: 1000 });
        assert.deepEqual(rec.calls, ['drain', 'supervisor', 'step:a', 'step:b', 'container']);
        assert.equal(o.phase, STATES.STOPPED);
    });

    test('zero steps (the empty boundary): sequence still completes drain,supervisor,container', async () => {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        const ft = makeFakeTimers();
        await o.shutdown({ exit: () => {}, timers: ft.timers, deadlineMs: 1000 });
        assert.deepEqual(rec.calls, ['drain', 'supervisor', 'container']);
    });

    test('no health, no supervisor (both omitted): those phases are skipped, never a phantom call', async () => {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container);
        const ft = makeFakeTimers();
        await o.shutdown({ exit: () => {}, timers: ft.timers, deadlineMs: 1000 });
        assert.deepEqual(rec.calls, ['container']);
    });
});

describe('shutdown: exit codes -- OK', () => {
    test('a fully clean run exits EXITS.OK (0) exactly once', async () => {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        assert.deepEqual(exits, [EXITS.OK]);
        assert.equal(EXITS.OK, 0);
        assert.equal(o.phase, STATES.STOPPED);
    });
});

describe('shutdown: exit codes -- DIRTY (a rejecting phase)', () => {
    test('a rejecting container.shutdown() exits EXITS.DIRTY (1) exactly once, before the deadline', async () => {
        const rec = makeRecorder({ containerResult: () => Promise.reject(HOISTED_ERR) });
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 5000 });
        assert.deepEqual(exits, [EXITS.DIRTY]);
        assert.equal(EXITS.DIRTY, 1);
        assert.equal(ft.state.fired, false, 'a rejection must resolve before the deadline, never trigger it');
        assert.equal(ft.state.cleared, true);
        assert.equal(o.phase, STATES.STOPPED);
    });

    test('a synchronously-throwing drain() advances (does not skip supervisor/steps/container) -- DIRTY', async () => {
        const rec = makeRecorder({ drainThrows: true });
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        o.step('cleanup', () => rec.calls.push('step:cleanup'));
        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        assert.deepEqual(exits, [EXITS.DIRTY]);
        assert.deepEqual(rec.calls, ['drain', 'supervisor', 'step:cleanup', 'container']);
    });

    test('a rejecting supervisor.shutdown() advances to steps + container -- DIRTY', async () => {
        const rec = makeRecorder({ supervisorResult: () => Promise.reject(HOISTED_ERR) });
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        o.step('s', () => rec.calls.push('step:s'));
        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        assert.deepEqual(exits, [EXITS.DIRTY]);
        assert.deepEqual(rec.calls, ['drain', 'supervisor', 'step:s', 'container']);
    });

    test('a rejecting step still runs later steps + container -- DIRTY', async () => {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container, { health: rec.health });
        o.step('good-1', () => rec.calls.push('step:good-1'));
        o.step('bad', () => Promise.reject(HOISTED_ERR));
        o.step('good-2', () => rec.calls.push('step:good-2'));
        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        assert.deepEqual(exits, [EXITS.DIRTY]);
        assert.deepEqual(rec.calls, ['drain', 'step:good-1', 'step:good-2', 'container']);
    });
});

describe('shutdown: exit codes -- DEADLINE (2)', () => {
    test('a hung phase (never-resolving promise) is bounded by the injected deadline -> exit(DEADLINE) once', async () => {
        const rec = makeRecorder({ supervisorResult: () => new Promise(() => {}) });
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        const ft = makeFakeTimers();
        const exits = [];
        // Deliberately not awaited: the phase never resolves.
        o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        await Promise.resolve();
        assert.equal(ft.state.armed, true);
        assert.deepEqual(exits, []);
        ft.fire();
        assert.deepEqual(exits, [EXITS.DEADLINE]);
        assert.equal(EXITS.DEADLINE, 2);
        assert.equal(o.phase, STATES.STOPPED);
    });

    test('an injected setTimeout that THROWS while arming fails closed to EXITS.DEADLINE at once, '
        + 'WITHOUT rejecting the returned promise', async () => {
        const container = { async shutdown() {} };
        const o = new Orchestrator(container, { health: { drain() {} } });
        const throwingTimers = { setTimeout() { throw HOISTED_ERR; }, clearTimeout() {} };
        const exits = [];
        const p = o.shutdown({ exit: (c) => exits.push(c), timers: throwingTimers, deadlineMs: 1000 });
        await p; // must resolve; a rejecting-and-floated _run would hang this await forever.
        assert.deepEqual(exits, [EXITS.DEADLINE]);
        assert.equal(o.phase, STATES.STOPPED);
        // no wedge: a later call returns the SAME settled gate, never a new run.
        const p2 = o.shutdown({ exit: () => exits.push('x'), timers: throwingTimers });
        assert.equal(p2, p);
        assert.deepEqual(exits, [EXITS.DEADLINE]);
    });

    test('NO unhandled rejection is emitted across the throwing-setTimeout fail-closed path', async () => {
        let unhandled = 0;
        const onUnhandled = () => { unhandled++; };
        process.on('unhandledRejection', onUnhandled);
        try {
            const container = { async shutdown() {} };
            const o = new Orchestrator(container, { health: { drain() {} } });
            const throwingTimers = { setTimeout() { throw HOISTED_ERR; }, clearTimeout() {} };
            const exits = [];
            await o.shutdown({ exit: (c) => exits.push(c), timers: throwingTimers, deadlineMs: 1000 });
            // Give the microtask/macrotask queue a full turn so a floated rejection
            // (if the module regressed) would have had the chance to surface.
            await new Promise((r) => setTimeout(r, 10));
            assert.deepEqual(exits, [EXITS.DEADLINE]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        assert.equal(unhandled, 0, 'the throwing-setTimeout arm path must never produce an unhandled rejection');
    });
});

describe('shutdown: exit codes -- FORCED (3) via listen()', () => {
    test('a second signal mid-teardown force-exits EXITS.FORCED exactly once', async () => {
        let release;
        const held = new Promise((r) => { release = r; });
        const container = { shutdown() { return held; } };
        const o = new Orchestrator(container, { health: { drain() {} } });
        const exits = [];
        const dispose = o.listen({ signals: ['SIGUSR2'], exit: (c) => exits.push(c) });
        try {
            process.emit('SIGUSR2');
            assert.equal(o.phase, STATES.STOPPING);
            process.emit('SIGUSR2'); // second, mid-flight -> force
            assert.deepEqual(exits, [EXITS.FORCED]);
            assert.equal(EXITS.FORCED, 3);
            assert.equal(o.phase, STATES.FORCED);
            // a third signal after FORCED must not exit again (latch holds).
            process.emit('SIGUSR2');
            assert.deepEqual(exits, [EXITS.FORCED]);
        } finally {
            dispose();
            release();
            await held;
        }
        assert.deepEqual(exits, [EXITS.FORCED], 'releasing the held container after FORCED must not exit again');
    });
});

describe('shutdown: exit(code) is called EXACTLY ONCE on every path', () => {
    test('OK path: exit fires exactly once even if the deadline is fired AFTER completion', async () => {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container);
        const ft = makeFakeTimers();
        let exitCount = 0;
        await o.shutdown({ exit: () => { exitCount++; }, timers: ft.timers, deadlineMs: 1000 });
        assert.equal(exitCount, 1);
        ft.fire(); // an already-cleared timer firing must be a latched no-op
        assert.equal(exitCount, 1);
    });

    test('DIRTY path: exit fires exactly once', async () => {
        const rec = makeRecorder({ containerResult: () => Promise.reject(HOISTED_ERR) });
        const o = new Orchestrator(rec.container, { health: rec.health });
        const ft = makeFakeTimers();
        let exitCount = 0;
        await o.shutdown({ exit: () => { exitCount++; }, timers: ft.timers, deadlineMs: 1000 });
        assert.equal(exitCount, 1);
    });

    test('DEADLINE path: exit fires exactly once even if fire() is called twice (adversarial)', async () => {
        const rec = makeRecorder({ supervisorResult: () => new Promise(() => {}) });
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        const ft = makeFakeTimers();
        let exitCount = 0;
        o.shutdown({ exit: () => { exitCount++; }, timers: ft.timers, deadlineMs: 1000 });
        await Promise.resolve();
        ft.fire();
        ft.fire(); // duplicate deadline fire (adversarial) -- the latch must hold
        assert.equal(exitCount, 1);
    });
});

describe('shutdown: option bag validation', () => {
    test('options as a non-object primitive throws TypeError', () => {
        const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
        assert.throws(() => o.shutdown(7), TypeError);
    });

    test('exit as a non-function throws TypeError', () => {
        const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
        assert.throws(() => o.shutdown({ exit: 7 }), TypeError);
    });

    test('timers without setTimeout/clearTimeout throws TypeError', () => {
        const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
        assert.throws(() => o.shutdown({ timers: {} }), TypeError);
    });

    test('timers.setTimeout present but timers.clearTimeout missing throws TypeError', () => {
        const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
        assert.throws(() => o.shutdown({ timers: { setTimeout: () => 1 } }), TypeError);
    });

    test('timers = null throws TypeError', () => {
        const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
        assert.throws(() => o.shutdown({ timers: null }), TypeError);
    });

    describe('deadlineMs boundary matrix', () => {
        test('deadlineMs = 0 (the 0 boundary) throws TypeError (must be > 0)', () => {
            const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
            assert.throws(() => o.shutdown({ deadlineMs: 0 }), TypeError);
        });

        test('deadlineMs = -0 throws TypeError (not > 0)', () => {
            const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
            assert.throws(() => o.shutdown({ deadlineMs: -0 }), TypeError);
        });

        test('deadlineMs = -5 (negative) throws TypeError', () => {
            const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
            assert.throws(() => o.shutdown({ deadlineMs: -5 }), TypeError);
        });

        test('deadlineMs = 1 (the smallest positive integer, N=1 boundary) is accepted', () => {
            const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
            const ft = makeFakeTimers();
            assert.doesNotThrow(() => o.shutdown({ timers: ft.timers, deadlineMs: 1 }));
        });

        test('deadlineMs = NaN throws TypeError (not finite)', () => {
            const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
            assert.throws(() => o.shutdown({ deadlineMs: NaN }), TypeError);
        });

        test('deadlineMs = Infinity throws TypeError (not finite)', () => {
            const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
            assert.throws(() => o.shutdown({ deadlineMs: Infinity }), TypeError);
        });

        test('deadlineMs = -Infinity throws TypeError', () => {
            const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
            assert.throws(() => o.shutdown({ deadlineMs: -Infinity }), TypeError);
        });

        test('deadlineMs as a non-number (a numeric string) throws TypeError -- no coercion', () => {
            const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
            assert.throws(() => o.shutdown({ deadlineMs: '1000' }), TypeError);
        });

        test('deadlineMs omitted defaults (accepted, no throw)', () => {
            const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
            const ft = makeFakeTimers();
            assert.doesNotThrow(() => o.shutdown({ timers: ft.timers }));
        });
    });

    test('unknown option key throws with a did-you-mean hint', () => {
        const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
        assert.throws(() => o.shutdown({ dedlineMs: 5 }), /unknown option 'dedlineMs'.*'deadlineMs'/);
    });

    test('a bad options bag on an ALREADY-in-flight shutdown does NOT throw -- idempotency short-circuits '
        + 'before validation (documented ordering: validate only on the FIRST call)', async () => {
        const o = new Orchestrator({ shutdown() { return Promise.resolve(); } });
        const ft = makeFakeTimers();
        const p1 = o.shutdown({ timers: ft.timers, deadlineMs: 1000 });
        // A second call with an objectively invalid bag must be swallowed by the
        // idempotency gate, not validated and thrown.
        let threw = false;
        let p2;
        try { p2 = o.shutdown({ deadlineMs: -1 }); } catch { threw = true; }
        assert.equal(threw, false, 'a redundant shutdown() call re-validated instead of short-circuiting');
        assert.equal(p2, p1);
        await p1;
    });
});

describe('shutdown: adversarial case the planner did not think of', () => {
    test('a container.shutdown() that returns a thenable whose `.then` GETTER throws is caught '
        + '(fail-closed against a hostile thenable, not just a hostile Promise) -- DIRTY, exit once', async () => {
        const hostile = {};
        Object.defineProperty(hostile, 'then', {
            get() { throw new Error('hostile .then getter'); },
        });
        const container = { shutdown() { return hostile; } };
        const o = new Orchestrator(container, { health: { drain() {} } });
        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        assert.deepEqual(exits, [EXITS.DIRTY]);
        assert.equal(o.phase, STATES.STOPPED);
    });
});
