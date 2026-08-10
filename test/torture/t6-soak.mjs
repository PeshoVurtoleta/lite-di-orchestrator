/**
 * T6 -- retention soak. The AUTHORITY is FINALIZATION, not a counter trick.
 *
 * (The T6 REPLACEMENT: there is no steady-state hot loop on this cold lifecycle
 * machine, so the 0-alloc lane is T5's phase getter and this tier proves nothing
 * accretes across many full lifecycles.)
 *
 * 1e4 cycles of the WHOLE machine: new Orchestrator + step + listen (arms real
 * SIGTERM/SIGINT handlers) + shutdown (injected no-op exit + injected timers) + dispose,
 * then track the ORCHESTRATOR with lite-leak WITHOUT untracking it. The cleanup (NOOP) +
 * numeric tag capture NOTHING (held-value contract), so it is held only WEAKLY. After
 * the soak we settle HARD (>= 10 gc()+tick passes) and assert the finalization residual
 * tracker.size() <= RES = max(16, CYCLES/1000): an orchestrator really released is
 * collected (size--), one that leaked is not (its _steps array and settled
 * _shutdownPromise are releasable).
 *
 * Structural invariant (kept): the signal-listener census returns EXACTLY to baseline --
 * every listen() handler was removed by its disposer, no SIGTERM/SIGINT handler leak.
 *
 * (An earlier track+immediate-untrack asserted size()===0 -- a VACUOUS TAUTOLOGY:
 * unregister decrements the live counter synchronously, netting to 0 every cycle even if
 * the orchestrator were retained forever, and the break control only tripped the HEAP
 * gate. Fixed here per the promotion-ladder gate 2 -- a retention gate must FAIL on a
 * retained object.)
 *
 * DI_TORTURE_BREAK=1 retains each orchestrator in a module sink -> size() stays ~CYCLES
 * and BLOWS RES, tripping the residual gate DIRECTLY. (Whole-suite control; in a full run
 * an earlier tier may trip first -- prove the soak in isolation:
 * DI_TORTURE_BREAK=1 node --expose-gc -e "import('./test/torture/t6-soak.mjs').then(m=>m.run())".)
 */

import { createLeakTracker } from '@zakkster/lite-leak';
import { Orchestrator } from '../../Orchestrator.js';
import { check, BREAK, makeFakeTimers, STATS } from './harness.mjs';

const CYCLES = 10000;             // 1e4 full lifecycles
const WARMUP = 1000;              // JIT/IC one-time costs excluded from the delta
/** AUTHORITY residual ceiling. Clean leaves single digits; a real leak leaves ~CYCLES. */
const RES = Math.max(16, (CYCLES / 1000) | 0); // 16
// SECONDARY loose catastrophe backstop (NOT the authority -- the residual is). Bounds
// one-time growth. Measured clean (node --expose-gc): ~454 KB, residual size()=0 -- the
// delta is the ~CYCLES live leakRecords plus heap-position noise, NOT a per-cycle signal.
// Anchored at 2 MB (~4.5x the plateau) to catch only runaway; the residual owns retention.
const HEAP_DELTA_LIMIT = 2 * 1024 * 1024;
const NOOP = function () {};

/** BREAK: retains each orchestrator so it can NEVER be finalized -> size() stays ~CYCLES. */
const sink = [];

/** Hard settle: run FinalizationRegistry callbacks to ground before reading size(). */
async function settleHard() {
    for (let i = 0; i < 10; i++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 15));
    }
}

/** One full lifecycle, then tracked via lite-leak (never untracked). */
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

    // AUTHORITY: track the ORCHESTRATOR without untracking; finalization decides its
    // fate. Neither NOOP nor the numeric tag closes over `o` (held-value contract).
    tracker.track(o, NOOP, cyc);
    if (BREAK) sink.push(o); // pin -> can NEVER be finalized -> size() stays high.
}

export async function run() {
    const tracker = createLeakTracker({
        name: 'orchestrator-soak',
        onWarning: () => { STATS.warnings++; },
    });

    const baseTerm = process.listenerCount('SIGTERM');
    const baseInt = process.listenerCount('SIGINT');

    // Warm the WHOLE lifecycle path so first-run JIT/IC/hidden-class allocation is not
    // billed to the steady-state delta below.
    for (let cyc = 0; cyc < WARMUP; cyc++) await cycle(tracker, cyc);

    await settleHard();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let cyc = 0; cyc < CYCLES; cyc++) await cycle(tracker, cyc);

    await settleHard();

    // -- listener census returned to baseline (no handler leak) -----------------
    check(process.listenerCount('SIGTERM') === baseTerm,
        () => 'T6.census: SIGTERM leaked ' + (process.listenerCount('SIGTERM') - baseTerm) +
            ' handler(s) across ' + CYCLES + ' cycles');
    check(process.listenerCount('SIGINT') === baseInt,
        () => 'T6.census: SIGINT leaked ' + (process.listenerCount('SIGINT') - baseInt) +
            ' handler(s) across ' + CYCLES + ' cycles');

    // -- AUTHORITY: finalization residual ---------------------------------------
    const residual = tracker.size();
    const findings = tracker.audit();
    STATS.leakSize = residual;
    STATS.leakTarget = RES;
    STATS.findings = findings.length;

    check(findings.length === 0, () => 'T6.leak: lite-leak reported ' + findings.length + ' findings');
    check(residual <= RES,
        () => 'T6.leak: AUTHORITY finalization residual size()=' + residual + ' > ' + RES +
            ' -- Orchestrator instances outlived their shutdown/dispose');

    // -- SECONDARY (NOT the authority): coarse one-time-growth backstop ----------
    const heapAfter = process.memoryUsage().heapUsed;
    const delta = heapAfter - heapBefore;
    check(delta < HEAP_DELTA_LIMIT,
        () => 'T6.heap: (secondary) soak heap delta ' + (delta / 1024).toFixed(1) + ' KB >= ' +
            (HEAP_DELTA_LIMIT / 1024) + ' KB');

    if (sink.length > 0) sink.length = 0; // release the break control's garbage

    process.stderr.write('T6 soak: ' + CYCLES + ' full lifecycles clean' +
        ' | AUTHORITY residual size()=' + residual + '/' + RES + ' findings=' + findings.length +
        ' | census SIGTERM=' + (process.listenerCount('SIGTERM') - baseTerm) +
        ' SIGINT=' + (process.listenerCount('SIGINT') - baseInt) +
        ' | (secondary) heap delta=' + (delta / 1024).toFixed(1) + ' KB\n');
}
