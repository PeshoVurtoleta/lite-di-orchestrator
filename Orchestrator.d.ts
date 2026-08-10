/**
 * @zakkster/lite-di-orchestrator -- graceful-shutdown / process-lifecycle
 * capstone for a lite-di service kernel. No default export.
 *
 * @license MIT
 * (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 */

/** Lifecycle phases -- frozen int enum returned by `phase`. */
export const STATES: Readonly<{
    /** Nominal operation; no shutdown in flight. */
    RUNNING: 0;
    /** Readiness drained (readyz fails); liveness untouched. */
    DRAINING: 1;
    /** Supervisor disarmed, steps + container teardown running. */
    STOPPING: 2;
    /** Sequence complete (or deadline-exited); exit() has fired. */
    STOPPED: 3;
    /** A second signal forced an immediate exit mid-teardown. */
    FORCED: 4;
}>;

/** Process exit codes -- frozen int enum passed to exit(code). */
export const EXITS: Readonly<{
    /** Every phase completed cleanly within the deadline. */
    OK: 0;
    /** A phase threw/rejected but the sequence still finished in time. */
    DIRTY: 1;
    /** The whole sequence overran deadlineMs; the one-shot timer force-exited. */
    DEADLINE: 2;
    /** A second signal arrived while a shutdown was already in flight. */
    FORCED: 3;
}>;

/** Version string (three-place sync with package.json + CHANGELOG). */
export const VERSION: string;

/** A minimal container: the reverse-topological teardown, run LAST. */
export interface OrchestratorContainer {
    shutdown(...args: any[]): unknown;
}

/** A minimal health surface: `drain()` bleeds the ready lane, run FIRST. */
export interface OrchestratorHealth {
    drain(): unknown;
}

/** A minimal supervisor: `shutdown()` disarms self-healing, run before steps. */
export interface OrchestratorSupervisor {
    shutdown(...args: any[]): unknown;
}

/** Constructor options. Unknown keys throw with a did-you-mean hint. */
export interface OrchestratorOptions {
    /** If present, `health.drain()` runs first (RUNNING -> DRAINING). */
    health?: OrchestratorHealth;
    /** If present, `supervisor.shutdown()` runs before steps (disarm healing). */
    supervisor?: OrchestratorSupervisor;
}

/** The injectable timer surface (default: the host setTimeout/clearTimeout). */
export interface OrchestratorTimers {
    setTimeout(handler: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

/** Options for `listen()`. The only method that touches `process`. */
export interface OrchestratorListenOptions {
    /** Signals to trap (default ['SIGTERM','SIGINT']). */
    signals?: string[];
    /** Injected exit function (default process.exit). */
    exit?: (code: number) => void;
    /** Reserved; the double-signal force path is always active. */
    force?: boolean;
}

/** Options for `shutdown()`. All injectable for tests. */
export interface OrchestratorShutdownOptions {
    /** Injected exit function (default process.exit). Called exactly once. */
    exit?: (code: number) => void;
    /** Injected timer surface (default the host timers). */
    timers?: OrchestratorTimers;
    /** Hard deadline for the whole sequence, ms (default 10000). */
    deadlineMs?: number;
}

/** Removes every trapped signal handler; idempotent. Returned by `listen()`. */
export type OrchestratorDisposer = () => void;

/**
 * Graceful-shutdown / process-lifecycle orchestrator over a lite-di service
 * kernel. The constructor is PURE and INERT (touches no process global);
 * `listen()` opts into signal ownership and returns a reversible disposer.
 */
export class Orchestrator {
    /**
     * @param container REQUIRED: an object exposing a `shutdown()` method.
     * @param options   Optional `{ health?, supervisor? }`. Unknown keys throw.
     */
    constructor(container: OrchestratorContainer, options?: OrchestratorOptions);

    /** Current lifecycle phase (one of STATES). HOT, 0 B/op. */
    readonly phase: number;

    /**
     * Register an ordered app-cleanup step. COLD, append-only. Runs during
     * STOPPING, after supervisor.shutdown() and before container.shutdown().
     * @param name Non-empty string|symbol, unique (duplicate throws).
     * @param fn   The step (may be async); its rejection records a dirty exit.
     */
    step(name: string | symbol, fn: () => unknown): void;

    /**
     * Trap signals and drive shutdown() on each. The ONLY method that touches
     * `process`. A second install throws. Returns an idempotent disposer.
     */
    listen(options?: OrchestratorListenOptions): OrchestratorDisposer;

    /**
     * Run the ordered teardown and exit exactly once. IDEMPOTENT: a second call
     * returns the same promise. Resolves after exit(code) has fired.
     */
    shutdown(options?: OrchestratorShutdownOptions): Promise<void>;
}
