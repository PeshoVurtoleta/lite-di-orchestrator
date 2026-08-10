// test/construction.test.js -- constructor purity/inertness + duck-type +
// unknown-option boundary matrix, and the frozen export shape. Independent of
// test/torture/t0-laws.mjs and t1-construct.mjs -- this is the node:test
// boundary layer, traced to decisions/0001-orchestrator-model.md ("Fixed
// input -- signal ownership", Fork 4) and the ratified public surface.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator, STATES, EXITS, VERSION } from '../Orchestrator.js';

const CONTAINER = { shutdown() { return Promise.resolve(); } };

describe('exports', () => {
    test('exports Orchestrator, STATES, EXITS, VERSION', () => {
        assert.equal(typeof Orchestrator, 'function');
        assert.equal(typeof STATES, 'object');
        assert.equal(typeof EXITS, 'object');
        assert.equal(typeof VERSION, 'string');
    });

    test('VERSION is 1.0.0-alpha.1', () => {
        assert.equal(VERSION, '1.0.0-alpha.1');
    });

    test('there is no default export', async () => {
        const mod = await import('../Orchestrator.js');
        assert.equal(Object.prototype.hasOwnProperty.call(mod, 'default'), false);
    });

    test('STATES is frozen with the ratified int enum', () => {
        assert.equal(Object.isFrozen(STATES), true);
        assert.deepEqual(STATES, { RUNNING: 0, DRAINING: 1, STOPPING: 2, STOPPED: 3, FORCED: 4 });
    });

    test('EXITS is frozen with the ratified int enum', () => {
        assert.equal(Object.isFrozen(EXITS), true);
        assert.deepEqual(EXITS, { OK: 0, DIRTY: 1, DEADLINE: 2, FORCED: 3 });
    });

    test('a mutation attempt on STATES/EXITS is silently rejected (non-strict-mode freeze proof)', () => {
        const before = { ...STATES };
        try { STATES.RUNNING = 99; } catch { /* strict-mode throw is also acceptable */ }
        assert.deepEqual(STATES, before);
    });
});

describe('constructor: purity + inertness (the ratified fixed input)', () => {
    test('the constructor touches no process global: SIGTERM/SIGINT listener count unchanged', () => {
        const baseTerm = process.listenerCount('SIGTERM');
        const baseInt = process.listenerCount('SIGINT');
        new Orchestrator(CONTAINER);
        assert.equal(process.listenerCount('SIGTERM'), baseTerm);
        assert.equal(process.listenerCount('SIGINT'), baseInt);
    });

    test('a fresh instance is phase RUNNING (0)', () => {
        const o = new Orchestrator(CONTAINER);
        assert.equal(o.phase, STATES.RUNNING);
        assert.equal(o.phase, 0);
    });

    test('N constructions (boundary: 0, 1, N-1, N, N+1 around a small N) leave the census untouched', () => {
        const baseTerm = process.listenerCount('SIGTERM');
        const N = 5;
        const counts = [0, 1, N - 1, N, N + 1];
        for (const n of counts) {
            for (let i = 0; i < n; i++) new Orchestrator(CONTAINER);
            assert.equal(process.listenerCount('SIGTERM'), baseTerm,
                `listener count moved after ${n} constructions`);
        }
    });
});

describe('constructor: container duck-typing (fail-closed)', () => {
    test('container === null throws TypeError', () => {
        assert.throws(() => new Orchestrator(null), TypeError);
    });

    test('container === undefined throws TypeError', () => {
        assert.throws(() => new Orchestrator(undefined), TypeError);
    });

    test('container as a primitive (number) throws TypeError', () => {
        assert.throws(() => new Orchestrator(7), TypeError);
    });

    test('container as a primitive (string) throws TypeError', () => {
        assert.throws(() => new Orchestrator('nope'), TypeError);
    });

    test('container as NaN throws TypeError', () => {
        assert.throws(() => new Orchestrator(NaN), TypeError);
    });

    test('container as -0 throws TypeError (a primitive, not an object)', () => {
        assert.throws(() => new Orchestrator(-0), TypeError);
    });

    test('container = {} (no shutdown method at all) throws TypeError', () => {
        assert.throws(() => new Orchestrator({}), TypeError);
    });

    test('container.shutdown as a non-function (number) throws TypeError', () => {
        assert.throws(() => new Orchestrator({ shutdown: 7 }), TypeError);
    });

    test('container.shutdown as null throws TypeError', () => {
        assert.throws(() => new Orchestrator({ shutdown: null }), TypeError);
    });

    test('container as an array (adversarial: arrays are objects, but still need .shutdown) throws TypeError', () => {
        assert.throws(() => new Orchestrator([]), TypeError);
    });

    test('a valid duck-typed container (no Container instance) constructs successfully', () => {
        let ok = true;
        try { new Orchestrator({ shutdown() { return 1; } }); } catch { ok = false; }
        assert.equal(ok, true);
    });
});

describe('constructor: options bag validation', () => {
    test('options === undefined constructs successfully (omitted)', () => {
        let ok = true;
        try { new Orchestrator(CONTAINER, undefined); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('options === null is accepted structurally (same as omitted)', () => {
        let ok = true;
        try { new Orchestrator(CONTAINER, null); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('options = {} (empty) constructs successfully', () => {
        let ok = true;
        try { new Orchestrator(CONTAINER, {}); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('options as a non-object primitive (number) throws TypeError', () => {
        assert.throws(() => new Orchestrator(CONTAINER, 7), TypeError);
    });

    test('options as a non-object primitive (string) throws TypeError', () => {
        assert.throws(() => new Orchestrator(CONTAINER, 'bad'), TypeError);
    });

    test('unknown option key throws with a did-you-mean hint', () => {
        assert.throws(
            () => new Orchestrator(CONTAINER, { helth: {} }),
            /unknown option 'helth'.*'health'/);
    });

    test('unknown option key with no close match throws without a hint', () => {
        let msg = '';
        try { new Orchestrator(CONTAINER, { zzzzzzzzzz: 1 }); } catch (e) { msg = e.message; }
        assert.match(msg, /unknown option 'zzzzzzzzzz'/);
        assert.equal(/Did you mean/.test(msg), false);
    });

    test('a Symbol-keyed option is invisible to the for-in unknown-key scan (adversarial)', () => {
        const sneaky = Symbol('sneaky');
        let ok = true;
        try { new Orchestrator(CONTAINER, { [sneaky]: 'ignored' }); } catch { ok = false; }
        assert.equal(ok, true);
    });
});

describe('constructor: health duck-typing (optional collaborator)', () => {
    test('health omitted constructs successfully (truly optional)', () => {
        let ok = true;
        try { new Orchestrator(CONTAINER, {}); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('health === undefined (explicit) is treated as omitted', () => {
        let ok = true;
        try { new Orchestrator(CONTAINER, { health: undefined }); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('health === null throws TypeError (must be omitted, never null)', () => {
        assert.throws(() => new Orchestrator(CONTAINER, { health: null }), TypeError);
    });

    test('health = {} (no drain method) throws TypeError', () => {
        assert.throws(() => new Orchestrator(CONTAINER, { health: {} }), TypeError);
    });

    test('health.drain as a non-function throws TypeError', () => {
        assert.throws(() => new Orchestrator(CONTAINER, { health: { drain: 1 } }), TypeError);
    });

    test('a valid duck-typed health constructs successfully', () => {
        let ok = true;
        try { new Orchestrator(CONTAINER, { health: { drain() {} } }); } catch { ok = false; }
        assert.equal(ok, true);
    });
});

describe('constructor: supervisor duck-typing (optional collaborator)', () => {
    test('supervisor omitted constructs successfully (truly optional)', () => {
        let ok = true;
        try { new Orchestrator(CONTAINER, {}); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('supervisor === undefined (explicit) is treated as omitted', () => {
        let ok = true;
        try { new Orchestrator(CONTAINER, { supervisor: undefined }); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('supervisor === null throws TypeError (must be omitted, never null)', () => {
        assert.throws(() => new Orchestrator(CONTAINER, { supervisor: null }), TypeError);
    });

    test('supervisor = {} (no shutdown method) throws TypeError', () => {
        assert.throws(() => new Orchestrator(CONTAINER, { supervisor: {} }), TypeError);
    });

    test('supervisor.shutdown as a non-function throws TypeError', () => {
        assert.throws(() => new Orchestrator(CONTAINER, { supervisor: { shutdown: 1 } }), TypeError);
    });

    test('a valid duck-typed supervisor constructs successfully', () => {
        let ok = true;
        try { new Orchestrator(CONTAINER, { supervisor: { shutdown() {} } }); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('both health and supervisor together construct successfully', () => {
        let ok = true;
        try {
            new Orchestrator(CONTAINER, { health: { drain() {} }, supervisor: { shutdown() {} } });
        } catch { ok = false; }
        assert.equal(ok, true);
    });
});

describe('constructor: adversarial cases the planner did not think of', () => {
    test('a container whose shutdown is a getter that THROWS on access fails closed (never a phantom pass)', () => {
        const evil = {};
        Object.defineProperty(evil, 'shutdown', {
            get() { throw new Error('adversarial getter'); },
        });
        // typeof evil.shutdown reads the getter -- the getter's throw must propagate,
        // not be swallowed into a false "no shutdown method" TypeError silently eaten.
        assert.throws(() => new Orchestrator(evil), /adversarial getter/);
    });

    test('a container with an inherited (prototype-chain) shutdown method is accepted (duck-typing does not require own-property)', () => {
        class Base { shutdown() { return Promise.resolve(); } }
        class Derived extends Base {}
        let ok = true;
        try { new Orchestrator(new Derived()); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('re-using the SAME container object across many Orchestrators is inert and independent', () => {
        const shared = { shutdown() { return Promise.resolve(); } };
        const a = new Orchestrator(shared);
        const b = new Orchestrator(shared);
        assert.notEqual(a, b);
        assert.equal(a.phase, STATES.RUNNING);
        assert.equal(b.phase, STATES.RUNNING);
    });

    test('a thenable passed as `container` (has .then but no .shutdown) throws TypeError, not silently awaited', () => {
        const thenable = { then(res) { res(); } };
        assert.throws(() => new Orchestrator(thenable), TypeError);
    });
});
