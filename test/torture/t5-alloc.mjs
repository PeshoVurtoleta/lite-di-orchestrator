/**
 * T5 -- the zero-alloc hot gate. `get phase()` is the ONLY hot lane on this cold
 * lifecycle machine: a lifecycle probe a supervisor loop or a readiness endpoint
 * may read often. It is a single property read -- no branch, no closure, no array,
 * no allocation -- so it is ZERO retained bytes per call, hard-gated two ways:
 *
 *   Lane A  measureAllocs at maxBytesPerCall:0 -- RETAINED bytes, forced-collect.
 *   Lane B  measureOps(stabilize:'deep') over 1e6 reads -- major/pause/arrayBuffers
 *           budget via checkNoGc(maxMajor:0). PASS iff bytes/op === 0.
 *
 * The getter is read across DIFFERENT phases (RUNNING and a settled STOPPED
 * instance) so the measured window is not a single constant-folded value.
 * DI_ALLOC_BREAK=1 (or DI_TORTURE_BREAK=1) injects one retained allocation PER
 * CALL into the measured body; the gate must then reject. That is the per-op control.
 */

import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';
import { Orchestrator } from '../../Orchestrator.js';
import { runOpsGate, ALLOC_BREAK, check, die, makeFakeTimers, STATS } from './harness.mjs';

const HOT = 1000000;      // 1e6 reads (>> any realistic probe floor)
// T5 is the DI_ALLOC_BREAK lane ONLY. DI_TORTURE_BREAK is the soak's control (T6),
// so it must flow THROUGH this tier untouched and trip the retention gate instead.
const INJECT = ALLOC_BREAK;

/** Retained sink for the break control -- survives GC so the gate must reject. */
const sink = [];

/** Consume the return so V8 cannot eliminate the read. */
let acc = 0;

/** Measure one 0-alloc hot thunk both ways; die on any leak (or on a passed break). */
function gateHot(label, hot) {
    const la = measureAllocs(hot, { iterations: 5000, batches: 12, warmup: 5000 });
    const ca = checkAllocs(la, { maxBytesPerCall: 0 });
    check(ca.verdict === 'pass' && la.bytesPerCall === 0,
        () => 'T5 ' + label + ' laneA: must be 0 B/op, measured ' + la.bytesPerCall +
            ' (verdict=' + ca.verdict + ')' + (INJECT ? ' (break control -- expected)' : ''));
    if (INJECT) die('T5 ' + label + ': DI_ALLOC_BREAK injected allocations but laneA passed');
    sink.length = 0;

    const { report, summary } = runOpsGate(hot, { ops: HOT, warmup: 5000 });
    if (!report.ok) {
        const g = summary.gc;
        die('T5 ' + label + ' laneB rejected -- verdict=' + report.verdict +
            ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
            ' abGrowth=' + summary.arrayBuffers.growthBytes +
            (INJECT ? ' (break control -- expected)' : ''));
    }
    if (INJECT) die('T5 ' + label + ': DI_ALLOC_BREAK injected allocations but laneB passed');
    return { la, summary };
}

export async function run() {
    // Everything the hot body touches is built ONCE here, outside every window.
    const running = new Orchestrator({ shutdown() { return Promise.resolve(); } });

    // A settled instance so the getter is read at a DIFFERENT phase int too.
    const stopped = new Orchestrator({ shutdown() { return Promise.resolve(); } });
    const ft = makeFakeTimers();
    await stopped.shutdown({ exit: () => {}, timers: ft.timers, deadlineMs: 1000 });
    check(running.phase === 0, () => 'T5: running instance not RUNNING(0)');
    check(stopped.phase === 3, () => 'T5: settled instance not STOPPED(3)');

    // Warm both reads.
    for (let i = 0; i < 5000; i++) { acc += running.phase; acc += stopped.phase; }

    // ---- get phase() on a RUNNING instance: the primary hot lane -------------
    const runHot = () => { acc += running.phase; if (INJECT) sink.push(new Float64Array(8)); };
    const rGate = gateHot('phase-running', runHot);

    // ---- get phase() on a STOPPED instance: a different constant, also 0 B/op --
    const stopHot = () => { acc += stopped.phase; if (INJECT) sink.push(new Float64Array(8)); };
    const sGate = gateHot('phase-stopped', stopHot);

    STATS.gcMajor = rGate.summary.gc.major;
    STATS.gcMinor = rGate.summary.gc.minor;
    STATS.gcMaxMs = rGate.summary.gc.maxMs;
    STATS.allocBytesPerOp = rGate.la.bytesPerCall;

    process.stderr.write(
        'T5 hot gate: phase()=' + rGate.la.bytesPerCall.toFixed(3) +
        ' B/op (running) ' + sGate.la.bytesPerCall.toFixed(3) + ' B/op (stopped) (' + HOT + ' reads)' +
        ' | laneB major=' + rGate.summary.gc.major + ' minor=' + rGate.summary.gc.minor +
        ' maxMs=' + rGate.summary.gc.maxMs.toFixed(3) +
        ' abGrowth=' + rGate.summary.arrayBuffers.growthBytes +
        ' | acc=' + (acc & 1) + '\n');
}
