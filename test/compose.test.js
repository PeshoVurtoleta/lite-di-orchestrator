// test/compose.test.js -- the money composition against the REAL sibling
// bricks (symlinked devDeps, not mocked): a Container with a few singletons,
// booted; a started Supervisor; folded into a real Health via
// watchSupervisor(); handed to an Orchestrator. Proves the ratified order and
// exit contract compose end to end, not just against fakes. Traced to
// decisions/0001-orchestrator-model.md ("Composes with") + Fork 1.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '@zakkster/lite-di-container';
import { Supervisor, STATES as SUP_STATES } from '@zakkster/lite-di-supervisor';
import { Health, LANES } from '@zakkster/lite-di-health';
import { Orchestrator, STATES, EXITS } from '../Orchestrator.js';

function makeFakeTimers() {
    const state = { cb: null, armed: false, cleared: false, fired: false };
    return {
        state,
        timers: {
            setTimeout(cb) { state.cb = cb; state.armed = true; return 1; },
            clearTimeout() { state.cleared = true; },
        },
    };
}

function bootedContainer(names) {
    const c = new Container();
    for (const name of names) {
        c.singleton(name, class { constructor() { this.name = name; } });
    }
    c.boot();
    return c;
}

describe('compose: the money composition -- real Container + Supervisor + Health', () => {
    test('shutdown() over the real bricks: readyz() fails during teardown, livez() is untouched by the '
        + 'orchestrator, the sequence completes OK, and the supervisor + container actually shut down', async () => {
        const c = bootedContainer(['db', 'cache']);

        const sup = new Supervisor(c, { children: ['db', 'cache'] });
        await sup.start();
        assert.equal(sup.state, SUP_STATES.RUNNING);

        const health = new Health();
        health.watchSupervisor('kernel', sup, LANES.READY);
        health.source('proc', () => true, LANES.LIVE);

        // Before shutdown: both lanes healthy.
        assert.equal(health.readyz(), 0);
        assert.equal(health.livez(), 0);

        const o = new Orchestrator(c, { health, supervisor: sup });

        let readyDuringStep = -1;
        let liveDuringStep = -1;
        let supStateDuringStep = -1;
        o.step('observe', () => {
            readyDuringStep = health.readyz();
            liveDuringStep = health.livez();
            supStateDuringStep = sup.state;
        });

        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (code) => exits.push(code), timers: ft.timers, deadlineMs: 5000 });

        // -- readiness started failing (drain flipped it) BEFORE the step ran -----
        assert.notEqual(readyDuringStep, 0,
            'health.readyz() must already be failing by the time a step observes it (drain runs first)');
        // -- liveness was NOT flipped by the orchestrator (drain never touches LIVE)
        assert.equal(liveDuringStep, 0,
            'health.livez() must stay untouched by the orchestrator teardown');
        // -- the supervisor was disarmed before the step ran ----------------------
        assert.equal(supStateDuringStep, SUP_STATES.SHUT_DOWN);

        // -- the sequence completed and exited OK exactly once --------------------
        assert.deepEqual(exits, [EXITS.OK]);
        assert.equal(o.phase, STATES.STOPPED);

        // -- post-shutdown: readiness stays failing, liveness stays live ----------
        assert.notEqual(health.readyz(), 0, 'readiness must not silently recover after a drain-on-shutdown');
        assert.equal(health.livez(), 0, 'liveness must stay live even after shutdown completes');

        // -- the real supervisor + container actually shut down -------------------
        assert.equal(sup.state, SUP_STATES.SHUT_DOWN);
        let reshutOk = true;
        try { await c.shutdown(); } catch { reshutOk = false; }
        assert.equal(reshutOk, true, 'the real container must be left in a re-shutdown-safe state');
    });

    test('a DIRTY composition: a faulted child mid-teardown (container.shutdown surfaces the failure) '
        + 'still completes the full ratified order and exits DIRTY, not OK', async () => {
        const c = bootedContainer(['a', 'b']);
        let releaseTeardown;
        const gate = new Promise((r) => { releaseTeardown = r; });
        c.onTeardown('b', async () => { await gate; throw new Error('compose.test.js: injected teardown fault'); });

        const sup = new Supervisor(c, { children: ['a', 'b'] });
        await sup.start();

        const health = new Health();
        health.watchSupervisor('kernel', sup, LANES.READY);

        const o = new Orchestrator(c, { health, supervisor: sup });
        const ft = makeFakeTimers();
        const exits = [];

        const p = o.shutdown({ exit: (code) => exits.push(code), timers: ft.timers, deadlineMs: 5000 });
        releaseTeardown();
        await p;

        assert.deepEqual(exits, [EXITS.DIRTY]);
        assert.equal(o.phase, STATES.STOPPED);
        assert.equal(sup.state, SUP_STATES.SHUT_DOWN, 'the supervisor must still be disarmed despite the later fault');
    });
});
