/**
 * @zakkster/lite-di-orchestrator -- torture gate.
 *
 * DONE-WHEN is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Tiers run STRICTLY SEQUENTIALLY -- lite-gc-profiler is one-measurement-at-a-time,
 * never nested, never concurrent:
 *
 *     T0  laws + ASCII control       T1  inert construction (signal census)
 *     T2  ratified sequence          T3  fail-closed exits (DIRTY/DEADLINE/FORCED)
 *     T4  disposer + idempotency     T5  the 0 B/op phase() gate
 *     T6  retention soak + lite-leak Tm  money composition (real bricks)
 *     T9  controls (must be able to fail)
 *
 * A tier signals failure via die() (exits non-zero). A thrown error is an
 * unexpected fault, surfaced with the replay seed. In BREAK mode (DI_TORTURE_BREAK,
 * DI_ALLOC_BREAK, or DI_ASCII_BREAK) the whole suite must exit non-zero; the
 * backstop below trips if a control failed to.
 *
 * @license MIT
 */

import { SEED, BREAK, ALLOC_BREAK, STATS } from './torture/harness.mjs';
import { run as t0 } from './torture/t0-laws.mjs';
import { run as t1 } from './torture/t1-construct.mjs';
import { run as t2 } from './torture/t2-sequence.mjs';
import { run as t3 } from './torture/t3-exits.mjs';
import { run as t4 } from './torture/t4-disposer.mjs';
import { run as t5 } from './torture/t5-alloc.mjs';
import { run as t6 } from './torture/t6-soak.mjs';
import { run as tm } from './torture/tmoney.mjs';
import { run as t9 } from './torture/t9-controls.mjs';

const TIERS = [
    ['T0 laws', t0],
    ['T1 construct', t1],
    ['T2 sequence', t2],
    ['T3 exits', t3],
    ['T4 disposer', t4],
    ['T5 alloc', t5],
    ['T6 soak', t6],
    ['Tm money', tm],
    ['T9 controls', t9],
];

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }

    for (const [name, run] of TIERS) {
        try {
            await run();
        } catch (err) {
            process.stderr.write(
                'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
            process.exit(1);
        }
    }

    // Reaching here in a BREAK mode means a control did not trip -- a fault.
    if (BREAK || ALLOC_BREAK || process.env.DI_ASCII_BREAK === '1') {
        process.stderr.write(
            'torture: FAIL -- a BREAK env var was set but the gate still passed\n');
        process.exit(1);
    }

    // One machine-readable GATE line on stderr; stdout stays exactly "ok".
    process.stderr.write(
        'GATE leak=size ' + STATS.leakSize + '/' + STATS.leakTarget +
        ' findings=' + STATS.findings + ' warnings=' + STATS.warnings +
        ' | gc major=' + STATS.gcMajor + ' minor=' + STATS.gcMinor +
        ' maxMs=' + STATS.gcMaxMs.toFixed(2) +
        ' | alloc=' + STATS.allocBytesPerOp.toFixed(3) + ' B/op\n');

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
