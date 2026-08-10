/**
 * T9 -- controls. Every gate above must be provably able to fail.
 *
 * Controls 1-3 are GENERIC (touch no package surface): they prove the alloc gate
 * and the retention witness BITE, and that the DI_ALLOC_BREAK / DI_TORTURE_BREAK
 * env flags are honored. Controls 4-6 are the package-specific VACUOUS-GATE
 * controls: the exactly-once exit latch, the ratified order, and the double-signal
 * FORCED path are load-bearing, not assumed -- a machine that exited twice, ran the
 * phases out of order, or ignored a second signal is caught here.
 *
 * Two whole-suite controls are wired through env vars the alloc + soak tiers read:
 *   - DI_ALLOC_BREAK=1   injects one allocation PER CALL so the 0 B phase gate trips.
 *   - DI_TORTURE_BREAK=1 retains one allocation per soak cycle so the heap gate trips.
 * Either must make `node --expose-gc test/torture.mjs` exit non-zero.
 */

import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { Orchestrator, STATES, EXITS } from '../../Orchestrator.js';
import { runOpsGate, ALLOC_BREAK, BREAK, die, makeFakeTimers, makeRecorder, HOISTED_ERR } from './harness.mjs';

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

export async function run() {
    // -- Control 1: the alloc gate bites. A hot body that retains an allocation
    //    every iteration MUST be rejected by runOpsGate -- the exact mechanism
    //    DI_ALLOC_BREAK uses to trip the 0 B/op phase gate.
    const { report } = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
    if (report.ok) die('T9 control 1: an allocating hot loop passed the zero-alloc gate');
    leak.length = 0;

    // -- Control 2: measureAllocs lane is not vacuous. A body that retains one
    //    object per call must fail maxBytesPerCall:0.
    const sink = [];
    const alloc = measureAllocs(() => { sink.push({ retained: true }); },
        { iterations: 2000, batches: 8, warmup: 2000 });
    const ca = checkAllocs(alloc, { maxBytesPerCall: 0 });
    if (ca.verdict === 'pass') {
        die('T9 control 2: measureAllocs passed a body that retains an object every call');
    }
    sink.length = 0;

    // -- Control 3: the retention witness bites. A tracked resource never untracked
    //    must leave tracker.size() > 0.
    {
        const tr = createLeakTracker({ name: 'orchestrator-control' });
        const h = tr.track({ live: true }, function () {}, 'ctl');
        if (tr.size() === 0) {
            die('T9 control 3: lite-leak size() was 0 with a live tracked resource -- the soak gate is blind');
        }
        tr.untrack(h);
    }

    // -- Control 3b: env flags are honored. When set, the flags the alloc + soak
    //    tiers read must be true, so their injection is guaranteed to fire.
    if (process.env.DI_ALLOC_BREAK === '1' && ALLOC_BREAK !== true) {
        die('T9 control 3b: DI_ALLOC_BREAK=1 but the harness did not surface it');
    }
    if (process.env.DI_TORTURE_BREAK === '1' && BREAK !== true) {
        die('T9 control 3b: DI_TORTURE_BREAK=1 but the harness did not surface it');
    }

    // -- Control 4: the exactly-once exit latch is load-bearing. A clean run must
    //    call exit exactly once. If the latch were vacuous (exit fired per phase, or
    //    the deadline double-exited), the count would exceed 1 and this dies.
    {
        const rec = makeRecorder();
        const o = new Orchestrator(rec.container, { health: rec.health, supervisor: rec.supervisor });
        o.step('a', () => {});
        const ft = makeFakeTimers();
        let exitCount = 0;
        await o.shutdown({ exit: () => { exitCount++; }, timers: ft.timers, deadlineMs: 1000 });
        if (exitCount !== 1) die('T9 control 4: exit fired ' + exitCount + ' times, expected exactly 1');
        // firing the (already cleared) deadline must NOT exit again.
        ft.fire();
        if (exitCount !== 1) die('T9 control 4: a post-completion deadline fire exited again (' + exitCount + ')');
    }

    // -- Control 5: the ratified order is load-bearing. drain MUST precede
    //    supervisor MUST precede the step MUST precede container. A reordering (or a
    //    dropped phase) changes the recorded log and this dies.
    {
        const rec = makeRecorder();
        const health = { drain() { rec.calls.push('drain'); } };
        const o = new Orchestrator(rec.container, { health, supervisor: rec.supervisor });
        o.step('mid', () => { rec.calls.push('step:mid'); });
        const ft = makeFakeTimers();
        await o.shutdown({ exit: () => {}, timers: ft.timers });
        const order = rec.calls.join(',');
        if (order !== 'drain,supervisor,step:mid,container') {
            die('T9 control 5: the ratified teardown order regressed, got ' + order);
        }
        if (o.phase !== STATES.STOPPED) die('T9 control 5: a clean run did not end STOPPED');
    }

    // -- Control 6: the double-signal FORCED path is not vacuous. A second signal
    //    mid-teardown MUST force exit(FORCED); if the machine ignored it, the exit
    //    would still be pending (0 exits) and this dies.
    {
        let release;
        const held = new Promise((r) => { release = r; });
        const container = { shutdown() { return held; } };
        const o = new Orchestrator(container, { health: { drain() {} } });
        const exits = [];
        const dispose = o.listen({ signals: ['SIGTERM'], exit: (c) => exits.push(c) });
        process.emit('SIGTERM'); // start (hangs at held container)
        process.emit('SIGTERM'); // force
        if (!(exits.length === 1 && exits[0] === EXITS.FORCED)) {
            die('T9 control 6: a second signal did not force FORCED once, got ' + exits.join(','));
        }
        dispose();
        release();
        await held; // let _run settle + clear its real timer
    }

    // -- Control 7: a rejecting phase is not vacuously "clean". A rejecting
    //    container MUST exit DIRTY (1), never OK (0). If the catch swallowed the
    //    fault into a clean exit, this dies.
    {
        const rec = makeRecorder({ containerResult: () => Promise.reject(HOISTED_ERR) });
        const o = new Orchestrator(rec.container, { health: rec.health });
        const ft = makeFakeTimers();
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers });
        if (!(exits.length === 1 && exits[0] === EXITS.DIRTY)) {
            die('T9 control 7: a rejecting container did not exit DIRTY, got ' + exits.join(','));
        }
    }
}
