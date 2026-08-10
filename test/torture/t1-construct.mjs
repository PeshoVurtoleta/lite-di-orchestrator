/**
 * T1 -- inert construction.
 *
 * The constructor is PURE and INERT: it touches NO process global. The proof is a
 * signal-listener census -- `process.listenerCount('SIGTERM')` and `'SIGINT'` are
 * UNCHANGED across a single `new Orchestrator(...)` AND across 1e4 constructions.
 * Only `listen()` may arm a handler; a bare construct never does. The 1e4-loop also
 * exercises the stable-hidden-class discipline (every field set unconditionally in
 * the constructor) -- a monomorphic construct path allocates the same shape each time.
 */

import { Orchestrator } from '../../Orchestrator.js';
import { check } from './harness.mjs';

const CONTAINER = { shutdown() { return Promise.resolve(); } };
const HEALTH = { drain() {} };
const SUPERVISOR = { shutdown() { return Promise.resolve(); } };

export async function run() {
    const baseTerm = process.listenerCount('SIGTERM');
    const baseInt = process.listenerCount('SIGINT');

    // A single construct arms nothing.
    {
        const o = new Orchestrator(CONTAINER);
        check(process.listenerCount('SIGTERM') === baseTerm,
            () => 'T1.inert: a single construct armed a SIGTERM handler');
        check(process.listenerCount('SIGINT') === baseInt,
            () => 'T1.inert: a single construct armed a SIGINT handler');
        // it is fully usable without ever touching process.
        check(o.phase === 0, () => 'T1.inert: fresh phase not RUNNING(0)');
    }

    // 1e4 constructs (with and without the optional collaborators) arm nothing and
    // keep a stable shape -- the census never moves.
    let sink = 0;
    for (let i = 0; i < 10000; i++) {
        const o = (i & 1) === 0
            ? new Orchestrator(CONTAINER)
            : new Orchestrator(CONTAINER, { health: HEALTH, supervisor: SUPERVISOR });
        o.step('s', () => {});
        sink += o.phase;
    }
    check(sink === 0, () => 'T1.inert: phase drifted from RUNNING during 1e4 constructs (sink=' + sink + ')');
    check(process.listenerCount('SIGTERM') === baseTerm,
        () => 'T1.inert: SIGTERM census moved across 1e4 constructs (' + baseTerm + ' -> ' +
            process.listenerCount('SIGTERM') + ')');
    check(process.listenerCount('SIGINT') === baseInt,
        () => 'T1.inert: SIGINT census moved across 1e4 constructs (' + baseInt + ' -> ' +
            process.listenerCount('SIGINT') + ')');
}
