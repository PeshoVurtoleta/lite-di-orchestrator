/**
 * T4 -- disposer + idempotency.
 *
 *   - listen() installs one handler per signal; the returned disposer removes
 *     EVERY one (the listener census returns to baseline).
 *   - a second listen() while installed THROWS (fail closed); the census is
 *     untouched by the rejected call.
 *   - the disposer is idempotent (a second call is a no-op, census unchanged).
 *   - after disposal, a fresh listen() works again (installed flag was cleared).
 *   - shutdown() called twice returns the SAME promise and exits exactly once.
 */

import { Orchestrator, EXITS } from '../../Orchestrator.js';
import { check, makeFakeTimers } from './harness.mjs';

const CONTAINER = { shutdown() { return Promise.resolve(); } };

export async function run() {
    // -- listen() install + disposer removes every handler ----------------------
    {
        const baseTerm = process.listenerCount('SIGTERM');
        const baseInt = process.listenerCount('SIGINT');
        const o = new Orchestrator(CONTAINER);
        const dispose = o.listen({ signals: ['SIGTERM', 'SIGINT'], exit: () => {} });
        check(process.listenerCount('SIGTERM') === baseTerm + 1,
            () => 'T4.install: SIGTERM handler not installed');
        check(process.listenerCount('SIGINT') === baseInt + 1,
            () => 'T4.install: SIGINT handler not installed');

        // a second listen() while installed throws, and installs nothing more.
        let threw = false;
        try { o.listen({ signals: ['SIGTERM'], exit: () => {} }); } catch (_e) { threw = true; }
        check(threw, () => 'T4.reinstall: a second listen() did not throw');
        check(process.listenerCount('SIGTERM') === baseTerm + 1,
            () => 'T4.reinstall: a rejected second listen() still installed a handler');

        // dispose removes every handler; the census returns to baseline.
        dispose();
        check(process.listenerCount('SIGTERM') === baseTerm,
            () => 'T4.dispose: SIGTERM census did not return to baseline');
        check(process.listenerCount('SIGINT') === baseInt,
            () => 'T4.dispose: SIGINT census did not return to baseline');

        // idempotent: a second dispose is a no-op.
        dispose();
        check(process.listenerCount('SIGTERM') === baseTerm,
            () => 'T4.dispose: a second dispose() moved the SIGTERM census');

        // a fresh listen() works again after disposal.
        const dispose2 = o.listen({ signals: ['SIGTERM'], exit: () => {} });
        check(process.listenerCount('SIGTERM') === baseTerm + 1,
            () => 'T4.reopen: listen() after disposal did not re-install');
        dispose2();
        check(process.listenerCount('SIGTERM') === baseTerm,
            () => 'T4.reopen: final dispose did not clean up');
    }

    // -- shutdown() is idempotent: same promise, exits once ---------------------
    {
        const o = new Orchestrator(CONTAINER);
        const ft = makeFakeTimers();
        const exits = [];
        const p1 = o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        const p2 = o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        check(p1 === p2, () => 'T4.idem: two shutdown() calls returned different promises');
        await p1;
        // a third call after completion still returns the same promise, no re-exit.
        const p3 = o.shutdown({ exit: (c) => exits.push(c) });
        check(p3 === p1, () => 'T4.idem: a post-completion shutdown() returned a different promise');
        await p3;
        check(exits.length === 1 && exits[0] === EXITS.OK,
            () => 'T4.idem: shutdown() exited ' + exits.length + ' times, expected exactly 1 (OK)');
    }

    // -- RE-ENTRANT idempotency: a synchronous collaborator that calls shutdown()
    //    again (canonically a health.drain() that re-enters) must NOT start a second
    //    teardown. The idempotency slot is reserved SYNCHRONOUSLY before _run's
    //    prefix, so the nested call sees the same gate. This PINS blocker B2:
    //    against a build that assigns _shutdownPromise after _run, the order is
    //    'drain,drain,supervisor,supervisor,container' and the two returns differ.
    {
        const calls = [];
        const container = { shutdown() { calls.push('container'); return Promise.resolve(); } };
        const supervisor = { shutdown() { calls.push('supervisor'); return Promise.resolve(); } };
        let o;
        let reentered = false;
        let reentrantReturn = null;
        const health = {
            drain() {
                calls.push('drain');
                if (!reentered) {
                    reentered = true;
                    // Re-enter shutdown() from inside the SYNCHRONOUS drain phase.
                    reentrantReturn = o.shutdown({ exit: () => {}, timers: makeFakeTimers().timers });
                }
            },
        };
        o = new Orchestrator(container, { health, supervisor });
        const ft = makeFakeTimers();
        const exits = [];
        const p1 = o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        await p1;

        check(calls.join(',') === 'drain,supervisor,container',
            () => 'T4.reentrant: a re-entrant shutdown() double-ran the teardown, order was ' + calls.join(','));
        check(reentrantReturn === p1,
            () => 'T4.reentrant: the re-entrant shutdown() returned a DIFFERENT promise (not the in-flight gate)');
        check(exits.length === 1 && exits[0] === EXITS.OK,
            () => 'T4.reentrant: exit fired ' + exits.length + ' times, expected exactly 1 (OK)');
    }
}
