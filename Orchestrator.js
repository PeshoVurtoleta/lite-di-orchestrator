/**
 * @zakkster/lite-di-orchestrator -- the graceful-shutdown / process-lifecycle
 * CAPSTONE of the @zakkster/lite-di-* service-kernel line.
 *
 * An Orchestrator owns the ORDER a long-running service tears itself down in when
 * a SIGTERM (or SIGINT) arrives: drain readiness so a load balancer stops routing,
 * disarm the self-healing supervisor so nothing restarts mid-teardown, run any
 * app-level cleanup steps while the graph is still alive, then dismantle the
 * container graph in reverse-topological order -- all under one hard DEADLINE, and
 * always ending in exactly one process exit with a diagnostic code.
 *
 * The ratified teardown sequence (see decisions/0001-orchestrator-model.md):
 *
 *   RUNNING  -> DRAINING:  health.drain()             (readyz fails; livez untouched)
 *   DRAINING -> STOPPING:  await supervisor.shutdown() (disarm self-healing FIRST)
 *                          for each step: await step() (graph still alive)
 *                          await container.shutdown()  (reverse-topo teardown, LAST)
 *   STOPPING -> STOPPED:   exit(code)
 *
 * Exit codes: OK (0) all phases clean within the deadline; DIRTY (1) a phase
 * threw/rejected but the sequence still finished in time; DEADLINE (2) the whole
 * sequence overran deadlineMs and the one-shot timer force-exited; FORCED (3) a
 * SECOND signal arrived while a shutdown was already in flight. exit(code) is
 * called EXACTLY ONCE across every path, guarded by the `_exited` latch.
 *
 * Fail-closed async discipline: each phase runs in its OWN `try { await ... }
 * catch { dirty = true; }`, so a synchronously-throwing drain(), a rejecting
 * collaborator shutdown, or a thenable with a throwing `.then` getter records a
 * dirty exit and ADVANCES -- it never wedges the machine and never skips the
 * deadline/exit. A hung phase is caught by the deadline timer, not by a hang.
 *
 * Signal ownership is OPT-IN and REVERSIBLE: the constructor is PURE and INERT
 * (it touches NO process global); `listen()` is the ONLY method that calls
 * `process.on`, and it returns an idempotent disposer that `process.off`s every
 * signal. A second `listen()` throws (fail closed).
 *
 * @license MIT
 * (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 */

const VERSION = '1.0.0';

/** Lifecycle phases -- frozen int enum. `phase` returns one of these. */
const STATES = Object.freeze({
    RUNNING: 0,
    DRAINING: 1,
    STOPPING: 2,
    STOPPED: 3,
    FORCED: 4,
});

/** Process exit codes -- frozen int enum. exit(code) is called with one of these. */
const EXITS = Object.freeze({
    OK: 0,
    DIRTY: 1,
    DEADLINE: 2,
    FORCED: 3,
});

// Hoisted phase ints so the machine compares against locals, never property reads.
const P_RUNNING = 0;
const P_DRAINING = 1;
const P_STOPPING = 2;
const P_STOPPED = 3;
const P_FORCED = 4;

// The default signals a service traps for graceful shutdown.
const DEFAULT_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT']);

// The default timer surface -- injectable via shutdown({ timers }). Reads the
// host globals ONCE at module init; never touches `process`.
const DEFAULT_TIMERS = Object.freeze({
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
});

// Allowed option keys per bag -- an unknown key is an error with a did-you-mean
// hint, never a silent ignore (fail closed).
const CTOR_OPTS = ['health', 'supervisor'];
const LISTEN_OPTS = ['signals', 'exit', 'force'];
const SHUTDOWN_OPTS = ['exit', 'timers', 'deadlineMs'];

/** Levenshtein distance -- cold path only, used for did-you-mean hints. */
function editDistance(a, b) {
    const al = a.length;
    const bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    const row = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) row[j] = j;
    for (let i = 1; i <= al; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= bl; j++) {
            const tmp = row[j];
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            let m = prev + cost;
            const del = row[j] + 1;
            const ins = row[j - 1] + 1;
            if (del < m) m = del;
            if (ins < m) m = ins;
            row[j] = m;
            prev = tmp;
        }
    }
    return row[bl];
}

/** Nearest known key to `key` in `known`, or null when nothing is close. */
function didYouMean(key, known) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < known.length; i++) {
        const d = editDistance(key, known[i]);
        if (d < bestD) { bestD = d; best = known[i]; }
    }
    return bestD <= 3 ? best : null;
}

/**
 * Fail closed on any own-enumerable key of `opts` not present in `known`, with a
 * did-you-mean hint. `label` names the option bag in the message. Cold path.
 */
function rejectUnknown(opts, known, label) {
    for (const key in opts) {
        if (!Object.prototype.hasOwnProperty.call(opts, key)) continue;
        if (known.indexOf(key) !== -1) continue;
        const hint = didYouMean(key, known);
        throw new Error(
            label + ": unknown option '" + key + "'." +
            (hint !== null ? " Did you mean '" + hint + "'?" : ''));
    }
}

/** A readable label for a string|symbol step name (cold, error messages only). */
function labelName(name) {
    return typeof name === 'symbol' ? name.toString() : String(name);
}

/**
 * Graceful-shutdown / process-lifecycle orchestrator over a lite-di service
 * kernel.
 *
 * The public surface (see decision 0001):
 *   new Orchestrator(container, { health?, supervisor? })
 *   .step(name, fn)   -> void      (COLD, append-only)
 *   .listen(options?) -> disposer  (the ONLY method touching `process`)
 *   .shutdown(options?) -> Promise (idempotent; exits exactly once)
 *   .phase            -> number    (HOT: 0 B/op)
 */
class Orchestrator {
    constructor(container, options) {
        // -- container: a non-null object exposing a shutdown() function. --------
        if (container === null || typeof container !== 'object' ||
            typeof container.shutdown !== 'function') {
            throw new TypeError(
                'Orchestrator: container must be an object with a shutdown() method.');
        }

        const opts = options === undefined ? null : options;
        if (opts !== null && typeof opts !== 'object') {
            throw new TypeError('Orchestrator: options must be an object.');
        }
        if (opts !== null) rejectUnknown(opts, CTOR_OPTS, 'Orchestrator');

        // -- health (optional): if present, must expose a drain() function. ------
        let health = null;
        if (opts !== null && opts.health !== undefined) {
            const h = opts.health;
            if (h === null || typeof h.drain !== 'function') {
                throw new TypeError(
                    'Orchestrator: health must be an object with a drain() method.');
            }
            health = h;
        }

        // -- supervisor (optional): if present, must expose a shutdown() fn. ------
        let supervisor = null;
        if (opts !== null && opts.supervisor !== undefined) {
            const s = opts.supervisor;
            if (s === null || typeof s.shutdown !== 'function') {
                throw new TypeError(
                    'Orchestrator: supervisor must be an object with a shutdown() method.');
            }
            supervisor = s;
        }

        // -- Every field set UNCONDITIONALLY (one stable hidden class). ----------
        this._container = container;
        this._health = health;             // object with drain(), or null
        this._supervisor = supervisor;     // object with shutdown(), or null
        this._steps = [];                  // { name, fn }[] -- app cleanup, in order
        this._phase = P_RUNNING;           // one of STATES; the hot-lane int
        this._exited = false;              // the exactly-once exit latch
        this._shutdownPromise = null;      // idempotency handle for shutdown()
        this._installed = false;           // whether listen() has armed handlers
        this._signals = null;              // installed signal names (defensive copy)
        this._handler = null;              // the single installed handler function
        this._exit = null;                 // the operative exit fn (set by shutdown)
        this._timer = null;                // the armed one-shot deadline handle, or null
        this._clearTimeout = null;         // the clearer paired with _timer, or null
    }

    // =======================================================
    //  HOT LANE -- phase: 0.000 B/op, no branch, no alloc.
    // =======================================================

    /** Current lifecycle phase (one of STATES). HOT, 0 B/op. */
    get phase() {
        return this._phase;
    }

    // =======================================================
    //  COLD LANE -- step(): append-only teardown registration.
    // =======================================================

    /**
     * Register an ordered app-cleanup step. COLD, append-only. `name` is a
     * non-empty string|symbol, unique (a duplicate throws); `fn` is a function
     * (else TypeError). Steps run during STOPPING, in registration order, AFTER
     * supervisor.shutdown() and BEFORE container.shutdown() -- the graph is still
     * fully constructed, so a step may resolve and use services.
     */
    step(name, fn) {
        const isString = typeof name === 'string';
        if ((!isString || name.length === 0) && typeof name !== 'symbol') {
            throw new TypeError('Orchestrator.step: name must be a non-empty string or a symbol.');
        }
        const steps = this._steps;
        for (let i = 0; i < steps.length; i++) {
            if (steps[i].name === name) {
                throw new Error("Orchestrator.step: duplicate step name '" + labelName(name) + "'.");
            }
        }
        if (typeof fn !== 'function') {
            throw new TypeError(
                "Orchestrator.step: fn for '" + labelName(name) + "' must be a function.");
        }
        steps.push({ name: name, fn: fn });
    }

    // =======================================================
    //  COLD LANE -- listen(): the ONLY method that touches `process`.
    // =======================================================

    /**
     * Trap signals and drive shutdown() on each. The ONLY method that touches the
     * `process` global. A second install THROWS (fail closed). Returns an
     * idempotent disposer that `process.off`s every trapped signal and flips the
     * armed flag back off. A SECOND signal arriving while a shutdown is already in
     * flight force-exits with EXITS.FORCED. `force` is reserved (the double-signal
     * force path is always active).
     */
    listen(options) {
        if (this._installed) {
            throw new Error(
                'Orchestrator.listen: already installed; call the disposer before installing again.');
        }
        const opts = options === undefined ? null : options;
        if (opts !== null && typeof opts !== 'object') {
            throw new TypeError('Orchestrator.listen: options must be an object.');
        }
        if (opts !== null) rejectUnknown(opts, LISTEN_OPTS, 'Orchestrator.listen');

        // -- signals: a non-empty array of signal-name strings. -----------------
        const signals = (opts !== null && opts.signals !== undefined)
            ? opts.signals : DEFAULT_SIGNALS;
        if (!Array.isArray(signals) || signals.length === 0) {
            throw new TypeError('Orchestrator.listen: signals must be a non-empty array of signal names.');
        }
        for (let i = 0; i < signals.length; i++) {
            if (typeof signals[i] !== 'string' || signals[i].length === 0) {
                throw new TypeError('Orchestrator.listen: each signal must be a non-empty string.');
            }
        }

        // -- exit: the injected process-exit function (default process.exit). ----
        const exit = (opts !== null && opts.exit !== undefined) ? opts.exit : process.exit;
        if (typeof exit !== 'function') {
            throw new TypeError('Orchestrator.listen: exit must be a function.');
        }

        // -- force: reserved; validated only (the double-signal path is always on).
        const force = (opts !== null && opts.force !== undefined) ? opts.force : false;
        if (typeof force !== 'boolean') {
            throw new TypeError('Orchestrator.listen: force must be a boolean.');
        }

        const self = this;
        const handler = function orchestratorSignal() {
            const ph = self._phase;
            // A second signal STRICTLY mid-flight (between RUNNING and STOPPED) is a
            // force: route through the single exit funnel, which clears the armed
            // deadline timer and exits FORCED exactly once (the latch guards it). At
            // FORCED time a shutdown is in flight, so `_exit` is already set.
            if (ph > P_RUNNING && ph < P_STOPPED) {
                self._settle(EXITS.FORCED, P_FORCED);
                return;
            }
            // First signal (or a late one after STOPPED): drive the ordered teardown.
            // shutdown() is idempotent, so a redundant call returns the same promise.
            self.shutdown({ exit: exit });
        };

        const armed = signals.slice();
        for (let i = 0; i < armed.length; i++) {
            process.on(armed[i], handler);
        }

        this._installed = true;
        this._signals = armed;
        this._handler = handler;
        // NOTE: the operative `_exit` is owned by shutdown(), not listen() -- the
        // handler drives shutdown({ exit }), which stores it. A single writer keeps
        // the FORCED funnel unambiguous and avoids the disposer nulling `_exit` out
        // from under an in-flight teardown.

        let disposed = false;
        return function dispose() {
            if (disposed) return;
            disposed = true;
            const sigs = self._signals;
            const h = self._handler;
            if (sigs !== null && h !== null) {
                for (let i = 0; i < sigs.length; i++) {
                    process.off(sigs[i], h);
                }
            }
            self._installed = false;
            self._signals = null;
            self._handler = null;
        };
    }

    // =======================================================
    //  COLD LANE -- shutdown(): the ordered async teardown.
    // =======================================================

    /**
     * Run the ratified teardown sequence and exit exactly once. IDEMPOTENT: a
     * second call (or one from the signal handler) returns the SAME promise and
     * never re-runs the sequence. `exit`, `timers`, and `deadlineMs` are injectable
     * for tests; the defaults are process.exit, the host timers, and 10000 ms.
     */
    shutdown(options) {
        // Idempotency FIRST -- a redundant call returns the in-flight promise
        // untouched (and never re-validates, never re-exits).
        if (this._shutdownPromise !== null) return this._shutdownPromise;

        const opts = options === undefined ? null : options;
        if (opts !== null && typeof opts !== 'object') {
            throw new TypeError('Orchestrator.shutdown: options must be an object.');
        }
        if (opts !== null) rejectUnknown(opts, SHUTDOWN_OPTS, 'Orchestrator.shutdown');

        const exit = (opts !== null && opts.exit !== undefined) ? opts.exit : process.exit;
        if (typeof exit !== 'function') {
            throw new TypeError('Orchestrator.shutdown: exit must be a function.');
        }

        const timers = (opts !== null && opts.timers !== undefined) ? opts.timers : DEFAULT_TIMERS;
        if (timers === null || typeof timers !== 'object' ||
            typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
            throw new TypeError(
                'Orchestrator.shutdown: timers must be { setTimeout, clearTimeout } functions.');
        }

        const deadlineMs = (opts !== null && opts.deadlineMs !== undefined) ? opts.deadlineMs : 10000;
        if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0) {
            throw new TypeError('Orchestrator.shutdown: deadlineMs must be a finite number > 0.');
        }

        // Store the operative exit so `_settle` (and the FORCED signal path) reach it
        // uniformly. RESERVE the idempotency slot SYNCHRONOUSLY -- before `_run`'s
        // synchronous prefix (deadline arm, phase -> DRAINING, the SYNCHRONOUS
        // health.drain()) can run and re-enter shutdown(). A `health.drain()` that
        // calls shutdown() again must see a non-null `_shutdownPromise` and get the
        // SAME gate back, never a second `_run`. The phase still advances to STOPPING
        // synchronously inside `_run` (it is NOT deferred behind an await), so the
        // double-signal window that reads `_phase` is preserved.
        this._exit = exit;
        let settle;
        const gate = new Promise((res) => { settle = res; });
        this._shutdownPromise = gate;
        // `_run` never rejects (every phase is caught; `_settle` swallows a throwing
        // exit/clearTimeout), so `.then(settle)` needs no rejection handler.
        this._run(timers, deadlineMs).then(settle);
        return gate;
    }

    /**
     * The single exit funnel. Checks-and-sets the `_exited` latch, records the final
     * phase atomically with it, clears the armed deadline timer, and calls the stored
     * exit -- each route (clean completion, deadline, double-signal FORCED) exits at
     * most once. A throwing clearTimeout or a throwing injected exit is swallowed so
     * `_run` can never reject through this path.
     */
    _settle(code, phase) {
        if (this._exited) return;
        this._exited = true;
        this._phase = phase;
        const t = this._timer;
        if (t !== null) {
            this._timer = null;
            try { this._clearTimeout(t); } catch (_e) { /* nothing sane to do */ }
        }
        try { this._exit(code); } catch (_e) { /* exit should terminate; a throwing injected exit must not reject _run */ }
    }

    /**
     * The ordered teardown body. NEVER rejects: every phase is caught in its own
     * try/await, so a throw/rejection records `dirty` and ADVANCES, and the terminal
     * exit runs through `_settle`, which swallows a throwing clearTimeout/exit. A hung
     * phase is bounded by the one-shot deadline timer, which force-exits with DEADLINE
     * via the same funnel. On clean or dirty completion `_settle` clears the deadline
     * and exits once.
     */
    async _run(timers, deadlineMs) {
        let dirty = false;

        // Arm the one-shot deadline BEFORE any phase so the WHOLE sequence is
        // bounded. This is NOT a hot path -- a single cold timer per shutdown. Store
        // the handle + clearer so `_settle` (any exit route) can cancel it. If the
        // injected timer THROWS while arming (a fake that passes the typeof check but
        // throws on call), we cannot bound the teardown -- fail closed: exit non-zero
        // at once through the funnel rather than run an unbounded sequence that could
        // hang. This is the ONLY sync-throw source in the prefix, so catching it here
        // makes `_run` genuinely non-rejecting (the `.then(settle)` in shutdown() needs
        // no rejection handler).
        const self = this;
        try {
            this._clearTimeout = timers.clearTimeout;
            this._timer = timers.setTimeout(function onDeadline() {
                self._settle(EXITS.DEADLINE, P_STOPPED);
            }, deadlineMs);
        } catch (_e) {
            this._settle(EXITS.DEADLINE, P_STOPPED);
            return;
        }

        // RUNNING -> DRAINING: bleed readiness (readyz fails; livez untouched).
        this._phase = P_DRAINING;
        if (this._health !== null) {
            try { this._health.drain(); } catch (_e) { dirty = true; }
        }

        // DRAINING -> STOPPING: disarm self-healing, run steps, dismantle the graph.
        this._phase = P_STOPPING;
        if (this._supervisor !== null) {
            try { await this._supervisor.shutdown(); } catch (_e) { dirty = true; }
        }
        const steps = this._steps;
        for (let i = 0; i < steps.length; i++) {
            try { await steps[i].fn(); } catch (_e) { dirty = true; }
        }
        try { await this._container.shutdown(); } catch (_e) { dirty = true; }

        // STOPPING -> STOPPED: exit exactly once through the funnel, which clears the
        // deadline. If the deadline already fired, `_settle` is a latched no-op.
        this._settle(dirty ? EXITS.DIRTY : EXITS.OK, P_STOPPED);
    }
}

export { Orchestrator, STATES, EXITS, VERSION };
