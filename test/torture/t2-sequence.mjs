/**
 * T2 -- the ratified teardown sequence.
 *
 * With a fake container/health/supervisor recording call order, assert the exact
 * ratified order:
 *
 *   drain -> supervisor.shutdown -> step[0] -> step[1] -> ... -> container.shutdown -> exit(OK)
 *
 * health.drain() is called EXACTLY ONCE; the orchestrator never touches any
 * liveness path. Steps run in registration order, AFTER supervisor.shutdown() and
 * BEFORE container.shutdown(). A run with no health / no supervisor skips those
 * phases cleanly (the optional collaborators are truly optional).
 */

import { Orchestrator, STATES, EXITS } from '../../Orchestrator.js';
import { check, makeRecorder, makeFakeTimers } from './harness.mjs';

export async function run() {
    // -- full topology: health + supervisor + steps + container -----------------
    {
        const rec = makeRecorder();
        let drainCount = 0;
        const health = { drain() { drainCount++; rec.calls.push('drain'); } };
        const o = new Orchestrator(rec.container, { health, supervisor: rec.supervisor });
        o.step('flush-logs', () => { rec.calls.push('step:flush-logs'); });
        o.step('close-server', async () => { rec.calls.push('step:close-server'); });

        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 5000 });

        const expected = 'drain,supervisor,step:flush-logs,step:close-server,container';
        check(rec.calls.join(',') === expected,
            () => 'T2.order: teardown order wrong\n  expected: ' + expected + '\n  actual:   ' + rec.calls.join(','));
        check(drainCount === 1, () => 'T2.drain: health.drain() called ' + drainCount + ' times, expected 1');
        check(exits.length === 1 && exits[0] === EXITS.OK,
            () => 'T2.exit: clean run did not exit OK once, got ' + exits.join(','));
        check(o.phase === STATES.STOPPED, () => 'T2.phase: not STOPPED after a clean run');
        check(ft.state.cleared === true, () => 'T2.deadline: timer not cleared on clean completion');
        check(ft.state.fired === false, () => 'T2.deadline: deadline fired on a clean, in-time run');
    }

    // -- no health, no supervisor: those phases are skipped cleanly --------------
    {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container);
        o.step('only-step', () => { rec.calls.push('step:only-step'); });
        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers });
        check(rec.calls.join(',') === 'step:only-step,container',
            () => 'T2.skip: missing health/supervisor did not skip cleanly, got ' + rec.calls.join(','));
        check(exits.length === 1 && exits[0] === EXITS.OK,
            () => 'T2.skip: minimal run did not exit OK once, got ' + exits.join(','));
    }

    // -- phase advances through the ratified states (observed at a step) ---------
    {
        const rec = makeRecorder();
        const health = { drain() { rec.calls.push('drain'); } };
        let phaseAtStep = -1;
        const o = new Orchestrator(rec.container, { health, supervisor: rec.supervisor });
        o.step('probe-phase', () => { phaseAtStep = o.phase; });
        const ft = makeFakeTimers();
        await o.shutdown({ exit: () => {}, timers: ft.timers });
        // By the time a step runs, drain (DRAINING) is done and we are STOPPING.
        check(phaseAtStep === STATES.STOPPING,
            () => 'T2.phase: a step observed phase ' + phaseAtStep + ', expected STOPPING(2)');
    }
}
