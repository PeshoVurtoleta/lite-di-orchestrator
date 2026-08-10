/**
 * T3 -- fail-closed exits. exit(code) is called EXACTLY ONCE in every case, and a
 * failing/hanging phase never wedges the machine or skips the deadline/exit.
 *
 *   1. A rejecting container.shutdown() still reaches exit(DIRTY), and does so
 *      BEFORE the deadline (the deadline timer is cleared, never fired).
 *   2. A synchronously-throwing drain() advances -- supervisor + steps + container
 *      still run, exit is DIRTY.
 *   3. A hung phase (a never-resolving promise) is bounded by the injected deadline
 *      timer -> exit(DEADLINE), exactly once.
 *   4. A SECOND signal arriving mid-teardown -> exit(FORCED), exactly once, no wait.
 *      (4b) the FORCED funnel clears the armed deadline timer.
 *   5. An injected setTimeout that THROWS while arming -> fail closed to exit(DEADLINE)
 *      at once, WITHOUT rejecting (_run stays non-rejecting; the gate resolves; no
 *      permanent wedge).
 *
 * Every throwing fake throws a HOISTED pre-constructed error, so the throw path is
 * 0-alloc and the fault is the injected one, never an allocation artifact.
 */

import { Orchestrator, STATES, EXITS } from '../../Orchestrator.js';
import { check, makeRecorder, makeFakeTimers, HOISTED_ERR } from './harness.mjs';

export async function run() {
    // -- Case 1: rejecting container.shutdown -> DIRTY, before the deadline ------
    {
        const rec = makeRecorder({ containerResult: () => Promise.reject(HOISTED_ERR) });
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 5000 });
        check(exits.length === 1 && exits[0] === EXITS.DIRTY,
            () => 'T3.1: a rejecting container did not exit DIRTY once, got ' + exits.join(','));
        check(ft.state.fired === false, () => 'T3.1: the deadline fired -- a rejection must finish before it');
        check(ft.state.cleared === true, () => 'T3.1: the deadline timer was not cleared after a dirty finish');
        check(o.phase === STATES.STOPPED, () => 'T3.1: not STOPPED after a dirty finish');
        // every earlier phase still ran.
        check(rec.calls.join(',') === 'drain,supervisor,container',
            () => 'T3.1: a rejecting container skipped earlier phases, got ' + rec.calls.join(','));
    }

    // -- Case 2: synchronously-throwing drain() -> advances, DIRTY --------------
    {
        const rec = makeRecorder({ drainThrows: true });
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        o.step('cleanup', () => { rec.calls.push('step:cleanup'); });
        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers });
        check(exits.length === 1 && exits[0] === EXITS.DIRTY,
            () => 'T3.2: a throwing drain() did not exit DIRTY once, got ' + exits.join(','));
        // a throwing drain must NOT abort the remaining teardown.
        check(rec.calls.join(',') === 'drain,supervisor,step:cleanup,container',
            () => 'T3.2: a throwing drain() aborted the teardown, got ' + rec.calls.join(','));
        check(o.phase === STATES.STOPPED, () => 'T3.2: not STOPPED after a throwing drain finished');
    }

    // -- Case 2b: a step that rejects -> DIRTY, later steps + container still run -
    {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container, { health: rec.health });
        o.step('good-1', () => { rec.calls.push('step:good-1'); });
        o.step('bad', () => Promise.reject(HOISTED_ERR));
        o.step('good-2', () => { rec.calls.push('step:good-2'); });
        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers });
        check(exits.length === 1 && exits[0] === EXITS.DIRTY,
            () => 'T3.2b: a rejecting step did not exit DIRTY once, got ' + exits.join(','));
        check(rec.calls.join(',') === 'drain,step:good-1,step:good-2,container',
            () => 'T3.2b: a rejecting step aborted the remaining teardown, got ' + rec.calls.join(','));
    }

    // -- Case 3: a hung phase -> DEADLINE via the injected timer, exactly once ---
    {
        // supervisor.shutdown() never resolves. _run suspends at that await; the
        // injected deadline is the ONLY thing that can move the machine.
        const rec = makeRecorder({ supervisorResult: () => new Promise(() => {}) });
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        const ft = makeFakeTimers();
        const exits = [];
        // NOTE: do NOT await -- the promise never resolves (the phase is hung).
        o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        await Promise.resolve(); // let the synchronous prefix reach the hung await
        check(ft.state.armed === true, () => 'T3.3: the deadline timer was not armed before the hang');
        check(exits.length === 0, () => 'T3.3: exit fired before the deadline on a hung phase');
        ft.fire(); // simulate the deadline elapsing
        check(exits.length === 1 && exits[0] === EXITS.DEADLINE,
            () => 'T3.3: a hung phase did not force-exit DEADLINE once, got ' + exits.join(','));
        check(o.phase === STATES.STOPPED, () => 'T3.3: phase not STOPPED after a deadline force-exit');
        // container.shutdown was never reached (we hung at supervisor).
        check(rec.calls.join(',') === 'drain,supervisor',
            () => 'T3.3: unexpected calls past the hung phase, got ' + rec.calls.join(','));
    }

    // -- Case 4: a SECOND signal mid-teardown -> FORCED, exactly once ------------
    {
        // The first signal starts a shutdown whose container.shutdown() we hold open
        // (so the machine sits mid-teardown at STOPPING). A second signal forces an
        // immediate FORCED exit. We then release the container so _run finishes and
        // clears the real deadline timer -- no lingering timers.
        let releaseContainer;
        const held = new Promise((r) => { releaseContainer = r; });
        const container = { shutdown() { return held; } };
        const health = { drain() {} };
        const o = new Orchestrator(container, { health });
        const exits = [];
        const dispose = o.listen({ signals: ['SIGTERM'], exit: (c) => exits.push(c) });

        process.emit('SIGTERM'); // first signal: drives shutdown to the held container await
        check(o.phase === STATES.STOPPING,
            () => 'T3.4: after the first signal, phase was ' + o.phase + ', expected STOPPING(2)');
        check(exits.length === 0, () => 'T3.4: the first signal exited before completion');

        process.emit('SIGTERM'); // second signal mid-flight: force
        check(exits.length === 1 && exits[0] === EXITS.FORCED,
            () => 'T3.4: a second signal did not force-exit FORCED once, got ' + exits.join(','));
        check(o.phase === STATES.FORCED, () => 'T3.4: phase not FORCED after a double signal');

        // a THIRD signal after FORCED must not exit again (latch holds).
        process.emit('SIGTERM');
        check(exits.length === 1, () => 'T3.4: a third signal exited again, got ' + exits.join(','));

        dispose();
        releaseContainer();
        await held; // let _run resolve, clearTimeout the real deadline, _settle no-op
        check(exits.length === 1 && exits[0] === EXITS.FORCED,
            () => 'T3.4: releasing the held container triggered a second exit, got ' + exits.join(','));
    }

    // -- Case 4b: FORCED clears the armed deadline timer (N3) --------------------
    {
        // Drive the in-flight shutdown MANUALLY with INJECTED fake timers (so we can
        // inspect the timer), then force it via a signal. The FORCED funnel must
        // clear the armed timer -- otherwise it lingers up to deadlineMs under a
        // non-terminating injected exit.
        let releaseContainer;
        const held = new Promise((r) => { releaseContainer = r; });
        const container = { shutdown() { return held; } };
        const o = new Orchestrator(container, { health: { drain() {} } });
        const ft = makeFakeTimers();
        const exits = [];
        // Start with fake timers -> arms ft; phase advances to STOPPING (held).
        o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 5000 });
        await Promise.resolve();
        check(o.phase === STATES.STOPPING, () => 'T3.4b: manual shutdown did not reach STOPPING');
        check(ft.state.armed === true && ft.state.cleared === false,
            () => 'T3.4b: the deadline timer was not left armed pre-force');

        // Now arm a signal handler and fire a second "signal" to force.
        const dispose = o.listen({ signals: ['SIGTERM'], exit: (c) => exits.push(c) });
        process.emit('SIGTERM'); // phase is STOPPING -> FORCED via _settle
        check(exits.length === 1 && exits[0] === EXITS.FORCED,
            () => 'T3.4b: the forcing signal did not exit FORCED once, got ' + exits.join(','));
        check(ft.state.cleared === true,
            () => 'T3.4b: FORCED did not clear the armed deadline timer (N3 -- it would linger)');
        check(ft.state.fired === false, () => 'T3.4b: the deadline fired rather than being cleared');

        dispose();
        releaseContainer();
        await held; // _run resolves; _settle is a latched no-op
        check(exits.length === 1, () => 'T3.4b: a second exit fired after FORCED, got ' + exits.join(','));
    }

    // -- Case 5: an injected timers.setTimeout that THROWS on call -> fail closed ---
    {
        // A fake that passes shutdown()'s typeof check but throws when armed. We
        // cannot bound the teardown, so _run must exit DEADLINE at once through the
        // funnel WITHOUT rejecting: the gate resolves (await below would hang forever
        // on a floated rejection), no unhandled rejection, and no permanent wedge.
        const container = { async shutdown() {} };
        const o = new Orchestrator(container, { health: { drain() {} } });
        const throwingTimers = { setTimeout() { throw HOISTED_ERR; }, clearTimeout() {} };
        const exits = [];
        const p = o.shutdown({ exit: (c) => exits.push(c), timers: throwingTimers, deadlineMs: 1000 });
        await p; // MUST resolve -- a rejecting-and-floated _run would hang here.
        check(exits.length === 1 && exits[0] === EXITS.DEADLINE,
            () => 'T3.5: a throwing setTimeout did not fail closed to DEADLINE once, got ' + exits.join(','));
        check(o.phase === STATES.STOPPED, () => 'T3.5: phase not STOPPED after a failed deadline arm');
        // No wedge: a later shutdown() returns the SAME settled gate, never a new run.
        const p2 = o.shutdown({ exit: () => exits.push('x'), timers: throwingTimers });
        check(p2 === p, () => 'T3.5: post-failure shutdown() returned a different promise (wedge / re-run)');
        check(exits.length === 1, () => 'T3.5: a second shutdown() re-exited after a failed arm');
    }
}
