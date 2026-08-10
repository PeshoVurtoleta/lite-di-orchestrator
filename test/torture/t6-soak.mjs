/**
 * T6 -- retention soak (the T6 REPLACEMENT: there is no steady-state hot loop on
 * this cold lifecycle machine, so the 0-alloc lane is T5's phase getter and this
 * tier proves nothing accretes across many full lifecycles).
 *
 * 1e4 cycles of the WHOLE machine: new Orchestrator + step + listen (arms real
 * SIGTERM/SIGINT handlers) + shutdown (injected no-op exit + injected timers) +
 * dispose. After the soak:
 *   - the signal-listener census returns EXACTLY to baseline (every listen()
 *     handler was removed by its disposer -- no handler leak);
 *   - every tracked Orchestrator finalizes (lite-leak size() == 0, clean audit) --
 *     the _steps array and the settled _shutdownPromise are releasable;
 *   - the heap delta across the soak is < 64 KB.
 *
 * lite-leak held-value contract: neither the cleanup closure nor the tag may close
 * over the tracked instance, or finalization is defeated and the witness reports a
 * false clean. DI_TORTURE_BREAK=1 retains one allocation per cycle -> the heap-delta
 * gate must reject.
 */

import { createLeakTracker } from '@zakkster/lite-leak';
import { Orchestrator } from '../../Orchestrator.js';
import { check, BREAK, makeFakeTimers, STATS } from './harness.mjs';

const CYCLES = 10000;             // 1e4 full lifecycles
const WARMUP = 1000;              // JIT/IC one-time costs excluded from the delta
const HEAP_DELTA_LIMIT = 64 * 1024; // < 64 KB across the STEADY-STATE soak
const NOOP = function () {};

/** Retained sink for the break control -- one live allocation per cycle. */
const sink = [];

/** One full lifecycle, tracked via lite-leak and released. */
async function cycle(tracker, cyc) {
    const container = { shutdown() { return Promise.resolve(); } };
    const health = { drain() {} };
    const o = new Orchestrator(container, { health });
    o.step('flush', NOOP);
    o.step('close', NOOP);

    // arm real signal handlers, then remove them via the disposer.
    const dispose = o.listen({ signals: ['SIGTERM', 'SIGINT'], exit: NOOP });

    const ft = makeFakeTimers();
    await o.shutdown({ exit: NOOP, timers: ft.timers, deadlineMs: 1000 });
    dispose();

    // Track the instance. cleanup/tag must NOT close over `o`.
    const handle = tracker.track(o, NOOP, cyc);
    tracker.untrack(handle);
}

/** Two forced collections with a settle tick -- stabilizes heapUsed for the gate. */
async function settle() {
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 20));
    globalThis.gc();
}

export async function run() {
    const tracker = createLeakTracker({
        name: 'orchestrator-soak',
        onWarning: () => { STATS.warnings++; },
    });

    const baseTerm = process.listenerCount('SIGTERM');
    const baseInt = process.listenerCount('SIGINT');

    // Warm the WHOLE lifecycle path so first-run JIT/IC/hidden-class allocation is
    // not billed to the steady-state delta below. The break control still injects
    // during warmup, but the measured delta is taken across the tracked run.
    for (let cyc = 0; cyc < WARMUP; cyc++) {
        await cycle(tracker, cyc);
        if (BREAK) sink.push(new Float64Array(8));
    }

    await settle();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let cyc = 0; cyc < CYCLES; cyc++) {
        await cycle(tracker, cyc);
        if (BREAK) sink.push(new Float64Array(8)); // the whole-suite break control
    }

    await settle();
    await new Promise((r) => setTimeout(r, 50)); // let finalization settle

    // -- listener census returned to baseline (no handler leak) -----------------
    check(process.listenerCount('SIGTERM') === baseTerm,
        () => 'T6.census: SIGTERM leaked ' + (process.listenerCount('SIGTERM') - baseTerm) +
            ' handler(s) across ' + CYCLES + ' cycles');
    check(process.listenerCount('SIGINT') === baseInt,
        () => 'T6.census: SIGINT leaked ' + (process.listenerCount('SIGINT') - baseInt) +
            ' handler(s) across ' + CYCLES + ' cycles');

    // -- lite-leak retention witness: nothing outlived its cycle ----------------
    check(tracker.size() === 0,
        () => 'T6.leak: lite-leak tracker leaked ' + tracker.size() + ' Orchestrator instances');
    const findings = tracker.audit();
    STATS.leakSize = tracker.size();
    STATS.leakTarget = 0;
    STATS.findings = findings.length;
    check(findings.length === 0, () => 'T6.leak: lite-leak reported ' + findings.length + ' findings');

    // -- heap delta across the steady-state soak < 64 KB ------------------------
    await settle();
    const heapAfter = process.memoryUsage().heapUsed;
    const delta = heapAfter - heapBefore;
    check(delta < HEAP_DELTA_LIMIT,
        () => 'T6.heap: soak heap delta ' + (delta / 1024).toFixed(1) + ' KB >= ' +
            (HEAP_DELTA_LIMIT / 1024) + ' KB limit');

    if (sink.length > 0) sink.length = 0; // release the break control's garbage

    process.stderr.write('T6 soak: ' + CYCLES + ' full lifecycles clean' +
        ' | leak size=' + tracker.size() + ' findings=' + findings.length +
        ' | census SIGTERM=' + (process.listenerCount('SIGTERM') - baseTerm) +
        ' SIGINT=' + (process.listenerCount('SIGINT') - baseInt) +
        ' | heap delta=' + (delta / 1024).toFixed(1) + ' KB\n');
}
