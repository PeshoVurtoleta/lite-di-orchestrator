// test/listen.test.js -- listen(options?) boundary matrix: installs on the
// configured signals, second-listen throws, disposer removes listeners
// (listener census back to baseline), disposer idempotency, re-listen after
// dispose, and bad signals/exit/force option validation. Every test disposes
// in a `finally` so this suite never leaks a real process listener into later
// suites or the parent test runner. Traced to decisions/0001-orchestrator-model.md
// ("Fixed input -- signal ownership") and Fork 4 (double-signal FORCED).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator, EXITS } from '../Orchestrator.js';

const CONTAINER = { shutdown() { return Promise.resolve(); } };

// A private-ish signal name so this suite's install/dispose churn never
// collides with a real SIGTERM/SIGINT handler some other harness may have
// live at the same time. process.emit() on an arbitrary event name is legal.
const SIG_A = 'SIGUSR2';
const SIG_B = 'SIGTERM'; // also exercised directly for the default-signal proof

describe('listen: default install targets SIGTERM + SIGINT', () => {
    test('listen() with no options installs one handler each on SIGTERM and SIGINT', () => {
        const baseTerm = process.listenerCount('SIGTERM');
        const baseInt = process.listenerCount('SIGINT');
        const o = new Orchestrator(CONTAINER);
        const dispose = o.listen({ exit: () => {} });
        try {
            assert.equal(process.listenerCount('SIGTERM'), baseTerm + 1);
            assert.equal(process.listenerCount('SIGINT'), baseInt + 1);
        } finally {
            dispose();
        }
        assert.equal(process.listenerCount('SIGTERM'), baseTerm);
        assert.equal(process.listenerCount('SIGINT'), baseInt);
    });
});

describe('listen: installs exactly on the configured signal set', () => {
    test('a custom single-signal array installs on that signal ONLY (not SIGTERM/SIGINT too)', () => {
        const baseA = process.listenerCount(SIG_A);
        const baseTerm = process.listenerCount('SIGTERM');
        const o = new Orchestrator(CONTAINER);
        const dispose = o.listen({ signals: [SIG_A], exit: () => {} });
        try {
            assert.equal(process.listenerCount(SIG_A), baseA + 1);
            assert.equal(process.listenerCount('SIGTERM'), baseTerm);
        } finally {
            dispose();
        }
        assert.equal(process.listenerCount(SIG_A), baseA);
    });

    test('a multi-signal array (N=2) installs one handler per signal', () => {
        const baseA = process.listenerCount(SIG_A);
        const baseTerm = process.listenerCount(SIG_B);
        const o = new Orchestrator(CONTAINER);
        const dispose = o.listen({ signals: [SIG_A, SIG_B], exit: () => {} });
        try {
            assert.equal(process.listenerCount(SIG_A), baseA + 1);
            assert.equal(process.listenerCount(SIG_B), baseTerm + 1);
        } finally {
            dispose();
        }
        assert.equal(process.listenerCount(SIG_A), baseA);
        assert.equal(process.listenerCount(SIG_B), baseTerm);
    });

    test('a duplicate signal name within the array (adversarial: [SIG_A, SIG_A]) '
        + 'installs the SAME handler twice -- listenerCount reflects two entries, dispose removes both', () => {
        const baseA = process.listenerCount(SIG_A);
        const o = new Orchestrator(CONTAINER);
        const dispose = o.listen({ signals: [SIG_A, SIG_A], exit: () => {} });
        try {
            assert.equal(process.listenerCount(SIG_A), baseA + 2,
                'process.on is called once per array entry, even if the signal repeats');
        } finally {
            dispose();
        }
        assert.equal(process.listenerCount(SIG_A), baseA,
            'the disposer must process.off every armed entry, including duplicates');
    });
});

describe('listen: second install throws (fail closed)', () => {
    test('a second listen() while already installed throws, and does NOT install additional handlers', () => {
        const baseA = process.listenerCount(SIG_A);
        const o = new Orchestrator(CONTAINER);
        const dispose = o.listen({ signals: [SIG_A], exit: () => {} });
        try {
            assert.throws(() => o.listen({ signals: [SIG_A], exit: () => {} }), Error);
            assert.equal(process.listenerCount(SIG_A), baseA + 1,
                'a rejected second listen() must not leave a second handler installed');
        } finally {
            dispose();
        }
    });
});

describe('listen: disposer removes listeners + is idempotent', () => {
    test('the disposer removes every trapped signal (listenerCount back to baseline)', () => {
        const baseA = process.listenerCount(SIG_A);
        const o = new Orchestrator(CONTAINER);
        const dispose = o.listen({ signals: [SIG_A], exit: () => {} });
        dispose();
        assert.equal(process.listenerCount(SIG_A), baseA);
    });

    test('disposer called twice (duplicate dispose) is a no-op the second time -- census unchanged', () => {
        const baseA = process.listenerCount(SIG_A);
        const o = new Orchestrator(CONTAINER);
        const dispose = o.listen({ signals: [SIG_A], exit: () => {} });
        dispose();
        assert.equal(process.listenerCount(SIG_A), baseA);
        dispose(); // duplicate dispose -- must not go negative / throw / double-remove
        assert.equal(process.listenerCount(SIG_A), baseA);
    });

    test('disposer called N+1 times (a stress boundary: 5 redundant calls) never throws and never moves the census', () => {
        const baseA = process.listenerCount(SIG_A);
        const o = new Orchestrator(CONTAINER);
        const dispose = o.listen({ signals: [SIG_A], exit: () => {} });
        dispose();
        for (let i = 0; i < 5; i++) {
            assert.doesNotThrow(() => dispose());
        }
        assert.equal(process.listenerCount(SIG_A), baseA);
    });
});

describe('listen: re-listen after dispose', () => {
    test('a fresh listen() after disposal works again (installed flag correctly cleared)', () => {
        const baseA = process.listenerCount(SIG_A);
        const o = new Orchestrator(CONTAINER);
        const dispose1 = o.listen({ signals: [SIG_A], exit: () => {} });
        dispose1();
        assert.equal(process.listenerCount(SIG_A), baseA);

        const dispose2 = o.listen({ signals: [SIG_A], exit: () => {} });
        try {
            assert.equal(process.listenerCount(SIG_A), baseA + 1);
        } finally {
            dispose2();
        }
        assert.equal(process.listenerCount(SIG_A), baseA);
    });

    test('N re-listen/dispose cycles (boundary N=1, N=2, N=5) always return to baseline', () => {
        const baseA = process.listenerCount(SIG_A);
        const o = new Orchestrator(CONTAINER);
        for (const n of [1, 2, 5]) {
            for (let i = 0; i < n; i++) {
                const d = o.listen({ signals: [SIG_A], exit: () => {} });
                assert.equal(process.listenerCount(SIG_A), baseA + 1);
                d();
                assert.equal(process.listenerCount(SIG_A), baseA);
            }
        }
    });
});

describe('listen: option validation (fail closed, no partial install)', () => {
    test('signals = [] (empty array) throws and installs nothing', () => {
        const baseTerm = process.listenerCount('SIGTERM');
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signals: [] }), TypeError);
        assert.equal(process.listenerCount('SIGTERM'), baseTerm);
    });

    test('signals as a non-array (a string) throws', () => {
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signals: 'SIGTERM' }), TypeError);
    });

    test('signals as null throws', () => {
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signals: null }), TypeError);
    });

    test('signals containing a non-string entry (a number) throws and installs nothing', () => {
        const baseA = process.listenerCount(SIG_A);
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signals: [SIG_A, 7] }), TypeError);
        assert.equal(process.listenerCount(SIG_A), baseA,
            'a partially-valid array must not partially install before the invalid entry is found');
    });

    test('signals containing an empty string entry throws', () => {
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signals: [''] }), TypeError);
    });

    test('signals containing NaN throws', () => {
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signals: [NaN] }), TypeError);
    });

    test('exit as a non-function (number) throws', () => {
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signals: [SIG_A], exit: 7 }), TypeError);
    });

    test('exit = null throws', () => {
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signals: [SIG_A], exit: null }), TypeError);
    });

    test('force as a non-boolean (string) throws', () => {
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signals: [SIG_A], force: 'yes' }), TypeError);
    });

    test('force = 1 (truthy but not boolean, adversarial) throws -- no implicit coercion', () => {
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signals: [SIG_A], force: 1 }), TypeError);
    });

    test('unknown option key throws with a did-you-mean hint', () => {
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signls: [SIG_A] }), /unknown option 'signls'.*'signals'/);
    });

    test('options as a non-object primitive throws', () => {
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen(7), TypeError);
    });

    test('a rejected listen() call leaves the instance re-listenable (installed flag never flips on a throw)', () => {
        const baseA = process.listenerCount(SIG_A);
        const o = new Orchestrator(CONTAINER);
        assert.throws(() => o.listen({ signals: [] }), TypeError);
        const dispose = o.listen({ signals: [SIG_A], exit: () => {} });
        try {
            assert.equal(process.listenerCount(SIG_A), baseA + 1);
        } finally {
            dispose();
        }
    });
});

describe('listen: re-entrant write (a handler that calls process.on/off from inside the trap)', () => {
    test('a signal handler that itself calls listen()/dispose() on a DIFFERENT orchestrator '
        + 'during dispatch does not corrupt this orchestrator\'s own disposer', async () => {
        const baseA = process.listenerCount(SIG_A);
        const other = new Orchestrator({ shutdown() { return Promise.resolve(); } });

        const exits = [];
        const o = new Orchestrator(CONTAINER);
        const dispose = o.listen({
            signals: [SIG_A],
            exit: (c) => {
                exits.push(c);
                // Re-entrant: install and immediately dispose a second, unrelated
                // orchestrator's listener while this handler is still executing.
                const otherDispose = other.listen({ signals: [SIG_A], exit: () => {} });
                otherDispose();
            },
        });

        try {
            process.emit(SIG_A);
            await Promise.resolve();
            assert.equal(exits.length, 1);
        } finally {
            dispose();
        }
        assert.equal(process.listenerCount(SIG_A), baseA,
            'the re-entrant install/dispose on another instance must not leak a handler');
    });
});

describe('listen: dispose-during-iteration (adversarial -- disposing from within the handler itself)', () => {
    test('calling the disposer from INSIDE the signal handler it disarms does not throw '
        + 'and leaves the census clean', async () => {
        const baseA = process.listenerCount(SIG_A);
        const o = new Orchestrator(CONTAINER);
        let dispose;
        let called = 0;
        dispose = o.listen({
            signals: [SIG_A],
            exit: () => {
                called++;
                dispose(); // dispose from inside the handler that dispose() is about to remove
            },
        });
        assert.doesNotThrow(() => process.emit(SIG_A));
        await Promise.resolve();
        assert.equal(called, 1);
        assert.equal(process.listenerCount(SIG_A), baseA);
    });
});

describe('listen: composition with shutdown -- FORCED exit code (ratified: FORCED === 3)', () => {
    test('a second signal mid-teardown force-exits with EXITS.FORCED (3), exactly once', async () => {
        let release;
        const held = new Promise((r) => { release = r; });
        const container = { shutdown() { return held; } };
        const o = new Orchestrator(container, { health: { drain() {} } });
        const exits = [];
        const dispose = o.listen({ signals: [SIG_A], exit: (c) => exits.push(c) });
        try {
            process.emit(SIG_A); // first signal: starts shutdown, hangs at container
            process.emit(SIG_A); // second signal mid-flight: force
            assert.deepEqual(exits, [EXITS.FORCED]);
            assert.equal(EXITS.FORCED, 3);
        } finally {
            dispose();
            release();
            await held;
        }
    });
});
