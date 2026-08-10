/**
 * T0 -- orchestrator laws + the ASCII control.
 *
 * The frozen public surface (VERSION / STATES / EXITS), the full construction +
 * registration fail-closed matrix (container required with a shutdown() method,
 * unknown option key with a did-you-mean hint, health without drain, supervisor
 * without shutdown, step name/fn validation, shutdown/listen option bags), and the
 * no-console + ASCII source self-checks.
 *
 * The ASCII control lives here: the enforcing loop scans every shipped file
 * (package.json files[]) with the ASCII regex and fails the whole suite on any
 * non-ASCII byte, failing CLOSED on a declared-but-missing file. DI_ASCII_BREAK=1
 * pushes a poisoned in-memory entry so the enforcing loop itself exits non-zero,
 * proving the ASCII gate is enforcing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Orchestrator, STATES, EXITS, VERSION } from '../../Orchestrator.js';
import { check, makeFakeTimers } from './harness.mjs';

function throwsType(fn) {
    try { fn(); return false; } catch (e) { return e instanceof TypeError; }
}
function throwsMsg(fn) {
    try { fn(); return ''; } catch (e) { return e.message; }
}
function throws(fn) {
    try { fn(); return false; } catch (_e) { return true; }
}

const CONTAINER = { shutdown() { return Promise.resolve(); } };

export async function run() {
    // -- Law 0: VERSION three-place synced; STATES / EXITS frozen int enums ------
    {
        check(VERSION === '1.0.0-alpha.1', () => 'T0.version: VERSION is ' + VERSION);
        check(Object.isFrozen(STATES), () => 'T0.freeze: STATES is not frozen');
        check(Object.isFrozen(EXITS), () => 'T0.freeze: EXITS is not frozen');
        check(STATES.RUNNING === 0 && STATES.DRAINING === 1 && STATES.STOPPING === 2 &&
            STATES.STOPPED === 3 && STATES.FORCED === 4, () => 'T0.states: int enum wrong');
        check(EXITS.OK === 0 && EXITS.DIRTY === 1 && EXITS.DEADLINE === 2 && EXITS.FORCED === 3,
            () => 'T0.exits: int enum wrong');
    }

    // -- Law 1: a fresh instance is RUNNING and touches nothing -----------------
    {
        const o = new Orchestrator(CONTAINER);
        check(o.phase === STATES.RUNNING, () => 'T0.init: fresh instance not RUNNING');
    }

    // -- Law 2: container is required and must expose shutdown() ----------------
    {
        check(throwsType(() => new Orchestrator(null)), () => 'T0.ctor: null container accepted');
        check(throwsType(() => new Orchestrator(undefined)), () => 'T0.ctor: undefined container accepted');
        check(throwsType(() => new Orchestrator(7)), () => 'T0.ctor: primitive container accepted');
        check(throwsType(() => new Orchestrator({})), () => 'T0.ctor: container without shutdown() accepted');
        check(throwsType(() => new Orchestrator({ shutdown: 7 })),
            () => 'T0.ctor: container with non-function shutdown accepted');
    }

    // -- Law 3: options bag fail-closed + unknown key did-you-mean --------------
    {
        check(throwsType(() => new Orchestrator(CONTAINER, 7)),
            () => 'T0.opts: a primitive options bag was accepted');
        const msg = throwsMsg(() => new Orchestrator(CONTAINER, { helth: {} }));
        check(msg.indexOf("unknown option 'helth'") !== -1 && msg.indexOf("'health'") !== -1,
            () => 'T0.opts: unknown key did-you-mean missing, got: ' + msg);
        const msg2 = throwsMsg(() => new Orchestrator(CONTAINER, { zzzz: 1 }));
        check(msg2.indexOf("unknown option 'zzzz'") !== -1,
            () => 'T0.opts: unknown key not rejected, got: ' + msg2);
    }

    // -- Law 4: health / supervisor duck-type fail-closed -----------------------
    {
        check(throwsType(() => new Orchestrator(CONTAINER, { health: {} })),
            () => 'T0.health: health without drain() accepted');
        check(throwsType(() => new Orchestrator(CONTAINER, { health: null })),
            () => 'T0.health: null health accepted (must be omitted, not null)');
        check(throwsType(() => new Orchestrator(CONTAINER, { supervisor: {} })),
            () => 'T0.sup: supervisor without shutdown() accepted');
        check(throwsType(() => new Orchestrator(CONTAINER, { supervisor: { shutdown: 1 } })),
            () => 'T0.sup: supervisor with non-function shutdown accepted');
        // a valid health + supervisor construct.
        let ok = true;
        try {
            new Orchestrator(CONTAINER, { health: { drain() {} }, supervisor: { shutdown() {} } });
        } catch { ok = false; }
        check(ok, () => 'T0.compose: a valid health+supervisor bag was rejected');
    }

    // -- Law 5: step() name + fn fail-closed ------------------------------------
    {
        const o = new Orchestrator(CONTAINER);
        check(throwsType(() => o.step('', () => {})), () => 'T0.step: empty-string name accepted');
        check(throwsType(() => o.step(7, () => {})), () => 'T0.step: numeric name accepted');
        check(throwsType(() => o.step(null, () => {})), () => 'T0.step: null name accepted');
        check(throwsType(() => o.step('a', 7)), () => 'T0.step: non-function fn accepted');
        // symbols are valid names.
        let symOk = true;
        try { o.step(Symbol('s'), () => {}); } catch { symOk = false; }
        check(symOk, () => 'T0.step: a symbol name was rejected');
        // duplicate name.
        o.step('dup', () => {});
        check(throwsMsg(() => o.step('dup', () => {})).indexOf('duplicate') !== -1,
            () => 'T0.step: a duplicate name was not rejected');
    }

    // -- Law 6: shutdown() option bag fail-closed -------------------------------
    {
        const o = new Orchestrator(CONTAINER);
        check(throwsType(() => o.shutdown({ exit: 7 })), () => 'T0.shutdown: non-function exit accepted');
        // NOTE: a fresh instance (no in-flight shutdown) validates the bag; once a
        // shutdown is in flight, the idempotent short-circuit returns before any
        // validation -- so use distinct instances for the bad-bag checks.
        check(throwsType(() => new Orchestrator(CONTAINER).shutdown(7)),
            () => 'T0.shutdown: primitive options bag accepted');
        check(throwsType(() => new Orchestrator(CONTAINER).shutdown({ timers: {} })),
            () => 'T0.shutdown: timers without setTimeout/clearTimeout accepted');
        check(throwsType(() => new Orchestrator(CONTAINER).shutdown({ deadlineMs: 0 })),
            () => 'T0.shutdown: deadlineMs 0 accepted');
        check(throwsType(() => new Orchestrator(CONTAINER).shutdown({ deadlineMs: -5 })),
            () => 'T0.shutdown: negative deadlineMs accepted');
        check(throwsMsg(() => new Orchestrator(CONTAINER).shutdown({ dedlineMs: 5 })).indexOf('unknown option') !== -1,
            () => 'T0.shutdown: unknown option key accepted');
    }

    // -- Law 7: listen() option bag fail-closed (no signals installed on throw) --
    {
        const base = process.listenerCount('SIGTERM');
        const o = new Orchestrator(CONTAINER);
        check(throws(() => o.listen({ signals: [] })), () => 'T0.listen: empty signals accepted');
        check(throws(() => o.listen({ signals: 'SIGTERM' })), () => 'T0.listen: non-array signals accepted');
        check(throws(() => o.listen({ signals: [7] })), () => 'T0.listen: non-string signal accepted');
        check(throws(() => o.listen({ exit: 7 })), () => 'T0.listen: non-function exit accepted');
        check(throws(() => o.listen({ force: 'yes' })), () => 'T0.listen: non-boolean force accepted');
        check(throwsMsg(() => o.listen({ signls: [] })).indexOf('unknown option') !== -1,
            () => 'T0.listen: unknown option key accepted');
        check(process.listenerCount('SIGTERM') === base,
            () => 'T0.listen: a rejected listen() still installed a SIGTERM handler');
    }

    // -- Law 8: exit-code / phase constants are wired to the ratified table ------
    {
        // A trivial end-to-end run confirms the constants are the ones the machine
        // uses (not just declared). Fake timers so no real timer is armed.
        const ft = makeFakeTimers();
        const o = new Orchestrator(CONTAINER);
        const exits = [];
        await o.shutdown({ exit: (c) => exits.push(c), timers: ft.timers, deadlineMs: 1000 });
        check(exits.length === 1 && exits[0] === EXITS.OK,
            () => 'T0.wire: a clean run did not exit EXITS.OK once, got ' + exits.join(','));
        check(o.phase === STATES.STOPPED, () => 'T0.wire: a clean run did not end in STOPPED');
        check(ft.state.cleared === true, () => 'T0.wire: the deadline timer was not cleared on clean completion');
    }

    // -- no-console self-check: the shipped module must contain no console.* -----
    {
        const src = readFileSync(fileURLToPath(new URL('../../Orchestrator.js', import.meta.url)), 'utf8');
        check(src.indexOf('console.') === -1, () => 'T0.console: Orchestrator.js contains a console.* call');
    }

    // -- ASCII control: the enforcing gate over shipped files -------------------
    {
        const grep = /[^\x00-\x7F]/;

        // Prove the regex bites and does not false-positive.
        const fixture = 'banner' + String.fromCharCode(0x2550) + 'end';
        check(grep.test(fixture), () => 'T0.ascii: the ASCII grep missed a U+2550 byte');
        check(!grep.test('pure ascii -> ok'), () => 'T0.ascii: the ASCII grep false-positived on ASCII');

        const root = fileURLToPath(new URL('../../', import.meta.url));
        const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
        const scanSet = [];
        for (const rel of pkg.files) {
            let srcText;
            // Fail CLOSED: a declared-but-missing shipped file is a manifest error,
            // never a silent skip (a skip would let the ASCII scan pass vacuously).
            try {
                srcText = readFileSync(root + rel, 'utf8');
            } catch (e) {
                check(false, () => 'T0.ascii: files[] entry ' + rel +
                    ' cannot be read (' + e.code + ') -- a shipped file must exist');
            }
            scanSet.push([rel, srcText]);
        }
        if (process.env.DI_ASCII_BREAK === '1') {
            scanSet.push(['<injected>', 'poison' + String.fromCharCode(0x2550)]);
        }
        for (const [rel, srcText] of scanSet) {
            const m = grep.exec(srcText);
            if (m !== null) {
                const line = srcText.slice(0, m.index).split('\n').length;
                check(false, () => 'T0.ascii: non-ASCII byte in shipped file ' + rel + ' at line ' + line +
                    ' (U+' + srcText.charCodeAt(m.index).toString(16).toUpperCase() + ')');
            }
        }
    }
}
