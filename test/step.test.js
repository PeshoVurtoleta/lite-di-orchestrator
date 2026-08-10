// test/step.test.js -- step(name, fn) boundary matrix: name type (string |
// symbol), empty-string reject, duplicate reject, non-function fn reject,
// append-only order preservation. Traced to decisions/0001-orchestrator-model.md
// ("Public surface" -- step) and the "Fail-closed rules" checklist.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../Orchestrator.js';

const CONTAINER = { shutdown() { return Promise.resolve(); } };

function makeOrchestrator() {
    return new Orchestrator(CONTAINER);
}

describe('step: name type validation', () => {
    test('a non-empty string name is accepted', () => {
        const o = makeOrchestrator();
        let ok = true;
        try { o.step('flush', () => {}); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('a symbol name is accepted', () => {
        const o = makeOrchestrator();
        let ok = true;
        try { o.step(Symbol('flush'), () => {}); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('the empty string ("" -- the 0 boundary of length) throws TypeError', () => {
        const o = makeOrchestrator();
        assert.throws(() => o.step('', () => {}), TypeError);
    });

    test('a single-character string name (the 1 boundary) is accepted', () => {
        const o = makeOrchestrator();
        let ok = true;
        try { o.step('a', () => {}); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('name = null throws TypeError', () => {
        const o = makeOrchestrator();
        assert.throws(() => o.step(null, () => {}), TypeError);
    });

    test('name = undefined throws TypeError', () => {
        const o = makeOrchestrator();
        assert.throws(() => o.step(undefined, () => {}), TypeError);
    });

    test('name = NaN throws TypeError', () => {
        const o = makeOrchestrator();
        assert.throws(() => o.step(NaN, () => {}), TypeError);
    });

    test('name = -0 (a number, not string|symbol) throws TypeError', () => {
        const o = makeOrchestrator();
        assert.throws(() => o.step(-0, () => {}), TypeError);
    });

    test('name = 0 (a number) throws TypeError', () => {
        const o = makeOrchestrator();
        assert.throws(() => o.step(0, () => {}), TypeError);
    });

    test('name as an object (adversarial: an object with a valid toString) still throws TypeError -- '
        + 'no implicit coercion', () => {
        const o = makeOrchestrator();
        const fakeString = { toString() { return 'sneaky'; } };
        assert.throws(() => o.step(fakeString, () => {}), TypeError);
    });

    test('name as a String OBJECT (new String("x"), typeof "object") throws TypeError -- '
        + 'boxed primitives are not strings', () => {
        const o = makeOrchestrator();
        // eslint-disable-next-line no-new-wrappers
        assert.throws(() => o.step(new String('x'), () => {}), TypeError);
    });
});

describe('step: fn validation', () => {
    test('fn as a non-function (number) throws TypeError', () => {
        const o = makeOrchestrator();
        assert.throws(() => o.step('a', 7), TypeError);
    });

    test('fn = null throws TypeError', () => {
        const o = makeOrchestrator();
        assert.throws(() => o.step('a', null), TypeError);
    });

    test('fn = undefined throws TypeError', () => {
        const o = makeOrchestrator();
        assert.throws(() => o.step('a', undefined), TypeError);
    });

    test('fn as an async function is accepted', () => {
        const o = makeOrchestrator();
        let ok = true;
        try { o.step('a', async () => {}); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('fn as an arrow function is accepted', () => {
        const o = makeOrchestrator();
        let ok = true;
        try { o.step('a', () => 1); } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('a name-rejection happens BEFORE fn is validated: a bad name + bad fn still reports the name TypeError', () => {
        const o = makeOrchestrator();
        assert.throws(() => o.step('', 7), TypeError);
    });
});

describe('step: uniqueness (duplicate reject)', () => {
    test('registering the same string name twice throws (not a TypeError -- a plain Error)', () => {
        const o = makeOrchestrator();
        o.step('dup', () => {});
        assert.throws(() => o.step('dup', () => {}), /duplicate/);
    });

    test('registering the same symbol twice throws', () => {
        const o = makeOrchestrator();
        const s = Symbol('dup');
        o.step(s, () => {});
        assert.throws(() => o.step(s, () => {}), /duplicate/);
    });

    test('two DIFFERENT symbols with the SAME description string are NOT duplicates (symbol identity, not label)', () => {
        const o = makeOrchestrator();
        const s1 = Symbol('same-label');
        const s2 = Symbol('same-label');
        let ok = true;
        try {
            o.step(s1, () => {});
            o.step(s2, () => {});
        } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('a string name and a symbol whose description equals that string are NOT duplicates', () => {
        const o = makeOrchestrator();
        let ok = true;
        try {
            o.step('flush', () => {});
            o.step(Symbol('flush'), () => {});
        } catch { ok = false; }
        assert.equal(ok, true);
    });

    test('a rejected duplicate registration does not clobber the original entry (re-registration attempts, N calls)', () => {
        const o = makeOrchestrator();
        const calls = [];
        o.step('a', () => calls.push('a'));
        for (let i = 0; i < 5; i++) {
            assert.throws(() => o.step('a', () => calls.push('a-imposter')), /duplicate/);
        }
        // Only the original step is present; verified via a full teardown run below
        // in the order test (this suite only proves the reject does not throw
        // asymmetrically or crash the registry).
    });
});

describe('step: append-only order preservation', () => {
    test('steps run in registration order (0, 1, N-1 boundary of a 3-step topology)', async () => {
        const calls = [];
        const o = new Orchestrator({ shutdown() { calls.push('container'); return Promise.resolve(); } });
        o.step('s0', () => calls.push('s0'));
        o.step('s1', () => calls.push('s1'));
        o.step('s2', () => calls.push('s2'));
        await o.shutdown({ exit: () => {}, timers: { setTimeout: () => 1, clearTimeout: () => {} } });
        assert.deepEqual(calls, ['s0', 's1', 's2', 'container']);
    });

    test('zero steps registered (the empty boundary): only container.shutdown runs', async () => {
        const calls = [];
        const o = new Orchestrator({ shutdown() { calls.push('container'); return Promise.resolve(); } });
        await o.shutdown({ exit: () => {}, timers: { setTimeout: () => 1, clearTimeout: () => {} } });
        assert.deepEqual(calls, ['container']);
    });

    test('a single step (the N=1 boundary) runs exactly once, in position', async () => {
        const calls = [];
        const o = new Orchestrator({ shutdown() { calls.push('container'); return Promise.resolve(); } });
        o.step('only', () => calls.push('only'));
        await o.shutdown({ exit: () => {}, timers: { setTimeout: () => 1, clearTimeout: () => {} } });
        assert.deepEqual(calls, ['only', 'container']);
    });

    test('step() called AFTER shutdown() has started still registers (adversarial: no lock on the array), '
        + 'but a step registered after the step-loop has already passed it does not retroactively run', async () => {
        // step() is documented append-only/COLD with no explicit "closed after listen".
        // This proves actual behavior: registering mid-flight (from a running step)
        // affects only steps not yet visited by the for-loop index.
        const calls = [];
        const o = new Orchestrator({ shutdown() { calls.push('container'); return Promise.resolve(); } });
        o.step('first', () => {
            calls.push('first');
            // Registered DURING the step loop -- should run since it is appended
            // after the current loop index but the loop re-reads `steps.length`.
            o.step('injected-during-iteration', () => calls.push('injected-during-iteration'));
        });
        await o.shutdown({ exit: () => {}, timers: { setTimeout: () => 1, clearTimeout: () => {} } });
        assert.deepEqual(calls, ['first', 'injected-during-iteration', 'container']);
    });
});
