/**
 * @zakkster/lite-di-orchestrator -- shared dependent torture harness (GENERIC).
 *
 * This file mirrors the shape used across every @zakkster/lite-di-* dependent. It
 * owns the discipline every tier obeys, and NOTHING package-specific:
 *
 *   - All scratch (instances, buffers, fakes) is allocated ONCE by the tier,
 *     outside every measured loop. This module hands out helpers, never per-call
 *     allocations on a hot path.
 *   - `check(cond, thunk)` builds its message string only on failure -- a template
 *     literal per iteration is an allocation and would fail the gate.
 *   - The PRNG is a seeded xorshift32. On any thrown fault a tier prints the seed
 *     so the case replays with `TORTURE_SEED=... npm run torture`.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run STRICTLY
 *     SEQUENTIALLY, never nested. `runOpsGate` opens and closes one window.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must never be seeded with 0
})();

/** Whole-suite control: retain one allocation per cycle in the soak. */
export const BREAK = process.env.DI_TORTURE_BREAK === '1';

/** Per-op alloc control: inject one allocation per hot op so the 0 B gate trips. */
export const ALLOC_BREAK = process.env.DI_ALLOC_BREAK === '1';

/** Base zero-GC rules. `maxArrayBuffersGrowth` needs measureOps `stabilize:'deep'`. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/**
 * Cross-tier stats, written by the alloc tier (gc + alloc) and the soak tier
 * (leak), read by the runner to emit one machine-readable GATE line on stderr.
 * stdout stays exactly "ok".
 */
export const STATS = {
    leakSize: 0,
    leakTarget: 0,
    findings: 0,
    warnings: 0,
    gcMajor: 0,
    gcMinor: 0,
    gcMaxMs: 0,
    allocBytesPerOp: 0,
};

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg +
        '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * measureOps with `stabilize:'deep'` makes the `maxArrayBuffersGrowth` rule
 * resolvable (ArrayBuffer backing stores live outside the V8 heap). Returns the
 * checkNoGc report, the raw summary, and the measured bytes-per-op rate.
 *
 * @param {(i:number)=>void} fn      Sync, zero-alloc hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return {
        report: checkNoGc(res.summary, RULES),
        summary: res.summary,
        bytesPerOp: res.bytesPerOp,
    };
}

/**
 * A controllable one-shot timer surface for shutdown({ timers }). `setTimeout`
 * records the callback; `fire()` invokes it (simulating a deadline); `clearTimeout`
 * marks it cleared. Never touches real time -- deterministic in tests.
 */
export function makeFakeTimers() {
    const state = { cb: null, ms: 0, armed: false, cleared: false, fired: false };
    return {
        state,
        timers: {
            setTimeout(cb, ms) {
                state.cb = cb;
                state.ms = ms;
                state.armed = true;
                state.cleared = false;
                state.fired = false;
                return 1;
            },
            clearTimeout() {
                state.cleared = true;
            },
        },
        fire() {
            if (state.cb !== null) { state.fired = true; state.cb(); }
        },
    };
}

/** A recording collaborator set: fake container/health/supervisor + a call log. */
export function makeRecorder(opts) {
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

/** A pre-constructed error so a throwing fake is 0-alloc per throw. */
export const HOISTED_ERR = new Error('torture: injected phase failure');
