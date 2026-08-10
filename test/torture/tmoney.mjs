/**
 * T-money -- the money composition against the REAL bricks.
 *
 * Build a @zakkster/lite-di-container with a few singletons + boot, wrap it in a
 * real @zakkster/lite-di-supervisor (started), fold that into a real
 * @zakkster/lite-di-health via watchSupervisor, hand all three to an Orchestrator,
 * and drive shutdown() with an injected exit + injected timers. Assert:
 *   - BEFORE shutdown, health.readyz() === 0 (ready) and livez() === 0 (live);
 *   - a step observing health mid-teardown sees readyz() ALREADY failing (drain ran
 *     RUNNING -> DRAINING before any step), while livez() stays 0 (never drained);
 *   - the whole sequence completes and exits EXITS.OK;
 *   - the real supervisor is SHUT_DOWN and the real container is torn down.
 *
 * This is the end-to-end proof that the ratified order composes with the real
 * collaborator surfaces, not just the fakes.
 */

import { Container } from '@zakkster/lite-di-container';
import { Supervisor, STATES as SUP_STATES } from '@zakkster/lite-di-supervisor';
import { Health, LANES } from '@zakkster/lite-di-health';
import { Orchestrator, STATES, EXITS } from '../../Orchestrator.js';
import { check, makeFakeTimers } from './harness.mjs';

export async function run() {
    // -- real container with a couple of singletons -----------------------------
    const c = new Container();
    c.singleton('db', class { constructor() { this.up = true; } });
    c.singleton('cache', class { constructor() { this.ok = true; } });
    c.boot();

    // -- real supervisor, started ----------------------------------------------
    const sup = new Supervisor(c, { children: ['db', 'cache'] });
    await sup.start();
    check(sup.state === SUP_STATES.RUNNING, () => 'Tmoney: supervisor did not start RUNNING');

    // -- real health folding the supervisor into readiness ----------------------
    const health = new Health();
    health.watchSupervisor('kernel', sup, LANES.READY);
    health.source('proc', () => true, LANES.LIVE);

    check(health.readyz() === 0, () => 'Tmoney: healthy kernel did not read ready before shutdown');
    check(health.livez() === 0, () => 'Tmoney: process not live before shutdown');

    // -- the orchestrator over all three real bricks ----------------------------
    const o = new Orchestrator(c, { health, supervisor: sup });

    let readyDuringStep = -1;
    let liveDuringStep = -1;
    let supStateDuringStep = -1;
    o.step('observe', () => {
        // Steps run during STOPPING: drain already flipped readyz, supervisor is
        // already shut down, but the container graph is still fully constructed.
        readyDuringStep = health.readyz();
        liveDuringStep = health.livez();
        supStateDuringStep = sup.state;
    });

    const ft = makeFakeTimers();
    const exits = [];
    await o.shutdown({ exit: (code) => exits.push(code), timers: ft.timers, deadlineMs: 5000 });

    // -- readiness started failing after drain; liveness never touched ----------
    check(readyDuringStep !== 0,
        () => 'Tmoney: health.readyz() was still 0 during teardown -- drain did not run first (got ' +
            readyDuringStep + ')');
    check(liveDuringStep === 0,
        () => 'Tmoney: liveness was affected by the teardown drain (got ' + liveDuringStep + ')');
    check(supStateDuringStep === SUP_STATES.SHUT_DOWN,
        () => 'Tmoney: supervisor was not shut down before the steps ran (state ' + supStateDuringStep + ')');

    // -- the sequence completed and exited OK -----------------------------------
    check(exits.length === 1 && exits[0] === EXITS.OK,
        () => 'Tmoney: the real composition did not exit OK once, got ' + exits.join(','));
    check(o.phase === STATES.STOPPED, () => 'Tmoney: not STOPPED after the real composition');
    check(sup.state === SUP_STATES.SHUT_DOWN, () => 'Tmoney: supervisor not SHUT_DOWN after shutdown');

    // -- readiness stays failing post-drain (the SIGTERM path never undrains) ----
    check(health.readyz() !== 0, () => 'Tmoney: readiness recovered after a drain-on-shutdown');
    check(health.livez() === 0, () => 'Tmoney: liveness dropped after shutdown (must stay live until exit)');

    // -- container is torn down (a second shutdown is a no-op) -------------------
    let reshutOk = true;
    try { await c.shutdown(); } catch (_e) { reshutOk = false; }
    check(reshutOk, () => 'Tmoney: the real container was left in a bad state after teardown');

    process.stderr.write('Tmoney: real container+supervisor+health composed; readyz ' +
        readyDuringStep + ' during teardown, exit=' + exits[0] + '\n');
}
