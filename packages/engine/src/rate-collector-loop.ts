// Rate history: always-on collector loop with a 15-minute schedule (#593, RFC 0004 §3).
//
// A long-running process that runs configured rate collector steps on a periodic
// schedule (default 15 minutes / 900,000 ms), with random startup jitter per run,
// an overlap guard that skips runs if the previous one is still in flight,
// and graceful shutdown on SIGTERM / SIGINT.

import { silentLogger, type Logger, type Metrics } from "./observability";

/** Standard 15-minute sampling interval in milliseconds (RFC 0004 §3). */
export const DEFAULT_COLLECTOR_INTERVAL_MS = 900_000;

/** Default maximum random startup jitter in milliseconds (5 seconds). */
export const DEFAULT_MAX_JITTER_MS = 5_000;

export interface CollectorStepResult {
  readonly collected?: number;
  readonly message?: string;
  readonly [key: string]: unknown;
}

export type CollectorStepFn = () =>
  Promise<CollectorStepResult | void> | CollectorStepResult | void;

export interface CollectorStep {
  readonly name: string;
  readonly run: CollectorStepFn;
}

export interface RateCollectorCycleResult {
  readonly status: "completed" | "skipped_overlap" | "aborted" | "error";
  readonly runCount: number;
  readonly skipCount: number;
  readonly skipped?: boolean;
  readonly durationMs?: number;
  readonly jitterMs?: number;
  readonly stepResults?: Record<string, CollectorStepResult | void>;
  readonly error?: string;
}

export interface RateCollectorLoopStats {
  readonly isRunning: boolean;
  readonly isExecuting: boolean;
  readonly runCount: number;
  readonly skipCount: number;
  readonly lastRunStartedAt?: number;
  readonly lastRunCompletedAt?: number;
  readonly lastRunDurationMs?: number;
  readonly lastError?: string;
}

export interface RateCollectorLoopOptions {
  /**
   * Interval between collection cycles in milliseconds.
   * Default: 15 minutes (900,000 ms), per RFC 0004 §3.
   */
  readonly intervalMs?: number;

  /**
   * Maximum random jitter applied before starting each cycle in milliseconds.
   * Default: 5,000 ms (5 seconds). Set to 0 to disable jitter.
   */
  readonly maxJitterMs?: number;

  /**
   * Registered collector steps to execute in order during each cycle.
   */
  readonly steps?: readonly CollectorStep[];

  /**
   * Optional custom collector callback function to execute if steps are not provided.
   */
  readonly runCollector?: CollectorStepFn;

  /**
   * Logger instance for operational logs and audit events.
   * Defaults to silentLogger.
   */
  readonly logger?: Logger;

  /**
   * Optional metrics recorder.
   */
  readonly metrics?: Metrics;

  /**
   * Optional random number generator (for deterministic testing of jitter).
   * Returns a float in [0, 1). Defaults to Math.random.
   */
  readonly randomFn?: () => number;

  /**
   * Optional sleep function (for deterministic testing with virtual timers).
   */
  readonly sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;

  /**
   * Optional time provider (returns epoch ms).
   * Defaults to Date.now.
   */
  readonly now?: () => number;

  /**
   * Whether to run the first collection immediately on start (plus jitter).
   * Default: true.
   */
  readonly runOnStart?: boolean;
}

/**
 * Parses a collector interval from environment string inputs (ms or seconds).
 */
export function parseCollectorInterval(
  envIntervalMs?: string,
  envIntervalSec?: string,
  fallbackMs: number = DEFAULT_COLLECTOR_INTERVAL_MS,
): number {
  if (envIntervalMs !== undefined && envIntervalMs !== "") {
    const parsed = parseInt(envIntervalMs, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  if (envIntervalSec !== undefined && envIntervalSec !== "") {
    const parsed = parseInt(envIntervalSec, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed * 1000;
  }
  return fallbackMs;
}

/**
 * Parses collector jitter from environment string input.
 */
export function parseCollectorJitter(
  envJitterMs?: string,
  fallbackMs: number = DEFAULT_MAX_JITTER_MS,
): number {
  if (envJitterMs !== undefined && envJitterMs !== "") {
    const parsed = parseInt(envJitterMs, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return fallbackMs;
}

/**
 * Default cancellable sleep implementation.
 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });
}

/**
 * An always-on rate collector loop with 15-minute scheduling, startup jitter,
 * overlap guard, and graceful shutdown (#593).
 */
export class RateCollectorLoop {
  public readonly intervalMs: number;
  public readonly maxJitterMs: number;
  private readonly steps: readonly CollectorStep[];
  private readonly runCollector?: CollectorStepFn;
  private readonly logger: Logger;
  private readonly metrics?: Metrics;
  private readonly randomFn: () => number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly runOnStart: boolean;

  private _isRunning = false;
  private _isExecuting = false;
  private _runCount = 0;
  private _skipCount = 0;
  private _lastRunStartedAt?: number;
  private _lastRunCompletedAt?: number;
  private _lastRunDurationMs?: number;
  private _lastError?: string;

  private _timer: NodeJS.Timeout | null = null;
  private _abortController: AbortController | null = null;
  private _currentRunPromise: Promise<RateCollectorCycleResult> | null = null;

  constructor(options: RateCollectorLoopOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_COLLECTOR_INTERVAL_MS;
    this.maxJitterMs = options.maxJitterMs ?? DEFAULT_MAX_JITTER_MS;
    this.steps = options.steps ?? [];
    this.runCollector = options.runCollector;
    this.logger = options.logger ?? silentLogger;
    this.metrics = options.metrics;
    this.randomFn = options.randomFn ?? Math.random;
    this.sleepFn = options.sleepFn ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.runOnStart = options.runOnStart ?? true;
  }

  public get isRunning(): boolean {
    return this._isRunning;
  }

  public get isExecuting(): boolean {
    return this._isExecuting;
  }

  public get runCount(): number {
    return this._runCount;
  }

  public get skipCount(): number {
    return this._skipCount;
  }

  public get stats(): RateCollectorLoopStats {
    return {
      isRunning: this._isRunning,
      isExecuting: this._isExecuting,
      runCount: this._runCount,
      skipCount: this._skipCount,
      lastRunStartedAt: this._lastRunStartedAt,
      lastRunCompletedAt: this._lastRunCompletedAt,
      lastRunDurationMs: this._lastRunDurationMs,
      lastError: this._lastError,
    };
  }

  /**
   * Starts the collector loop.
   */
  public start(): this {
    if (this._isRunning) {
      return this;
    }
    this._isRunning = true;
    this._abortController = new AbortController();

    this.logger.log("info", "corridor.rate_collector.started", {
      intervalMs: this.intervalMs,
      maxJitterMs: this.maxJitterMs,
      runOnStart: this.runOnStart,
      steps: this.steps.map((s) => s.name),
    });

    if (this.runOnStart) {
      void this.tick();
    }

    this._timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    return this;
  }

  /**
   * Gracefully stops the collector loop:
   * - Clears the scheduled interval timer.
   * - Aborts any pending jitter sleep.
   * - Awaits any currently in-flight collection run to complete cleanly.
   */
  public async stop(): Promise<void> {
    if (!this._isRunning) {
      return;
    }
    this._isRunning = false;

    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }

    if (this._abortController) {
      this._abortController.abort();
    }

    if (this._currentRunPromise) {
      this.logger.log("info", "corridor.rate_collector.draining", {
        message: "waiting for in-flight collection cycle to finish",
        runCount: this._runCount,
      });
      try {
        await this._currentRunPromise;
      } catch {
        // Handled within _executeCycle
      }
    }

    this.logger.log("info", "corridor.rate_collector.stopped", {
      runCount: this._runCount,
      skipCount: this._skipCount,
    });
  }

  /**
   * Executes a single collection tick.
   * Guarantees overlap protection: if a run is already in flight, skips immediately.
   */
  public tick(): Promise<RateCollectorCycleResult> {
    if (this._isExecuting) {
      this._skipCount++;
      this.metrics?.increment("corridor.rate_collector.skipped_overlap");
      this.logger.log("warn", "corridor.rate_collector.skipped_overlap", {
        message: "previous collection cycle is still running; skipping tick",
        runCount: this._runCount,
        skipCount: this._skipCount,
      });
      return Promise.resolve({
        status: "skipped_overlap",
        runCount: this._runCount,
        skipCount: this._skipCount,
        skipped: true,
      });
    }

    const p = this._executeCycle();
    this._currentRunPromise = p;
    p.finally(() => {
      if (this._currentRunPromise === p) {
        this._currentRunPromise = null;
      }
    });
    return p;
  }

  private async _executeCycle(): Promise<RateCollectorCycleResult> {
    this._isExecuting = true;
    const startedAt = this.now();
    this._lastRunStartedAt = startedAt;

    let jitterMs = 0;
    if (this.maxJitterMs > 0) {
      jitterMs = Math.floor(this.randomFn() * this.maxJitterMs);
    }

    if (jitterMs > 0) {
      this.logger.log("debug", "corridor.rate_collector.jitter_delay", {
        jitterMs,
        targetRun: this._runCount + 1,
      });
      try {
        await this.sleepFn(jitterMs, this._abortController?.signal);
      } catch {
        // Sleep aborted or errored
      }
    }

    if (this._abortController?.signal.aborted) {
      this._isExecuting = false;
      return {
        status: "aborted",
        runCount: this._runCount,
        skipCount: this._skipCount,
        jitterMs,
      };
    }

    const stepResults: Record<string, CollectorStepResult | void> = {};
    let hasError = false;
    let errorMessage: string | undefined;

    try {
      this.logger.log("info", "corridor.rate_collector.cycle_started", {
        runCount: this._runCount + 1,
        jitterMs,
        steps: this.steps.map((s) => s.name),
      });

      if (this.steps.length > 0) {
        for (const step of this.steps) {
          if (this._abortController?.signal.aborted) {
            break;
          }
          try {
            const res = await step.run();
            stepResults[step.name] = res;
          } catch (stepErr) {
            hasError = true;
            const msg = stepErr instanceof Error ? stepErr.message : String(stepErr);
            errorMessage = msg;
            this.logger.log("error", "corridor.rate_collector.step_failed", {
              step: step.name,
              error: msg,
            });
          }
        }
      } else if (this.runCollector) {
        try {
          const res = await this.runCollector();
          stepResults["default"] = res;
        } catch (cbErr) {
          hasError = true;
          const msg = cbErr instanceof Error ? cbErr.message : String(cbErr);
          errorMessage = msg;
          this.logger.log("error", "corridor.rate_collector.callback_failed", {
            error: msg,
          });
        }
      }
    } finally {
      const completedAt = this.now();
      const durationMs = completedAt - startedAt;
      this._lastRunCompletedAt = completedAt;
      this._lastRunDurationMs = durationMs;
      this._lastError = errorMessage;
      this._isExecuting = false;
      this._runCount++;

      this.metrics?.increment("corridor.rate_collector.runs");
      this.metrics?.timing("corridor.rate_collector.duration_ms", durationMs);

      if (hasError) {
        this.metrics?.increment("corridor.rate_collector.errors");
        this.logger.log("warn", "corridor.rate_collector.cycle_completed_with_errors", {
          runCount: this._runCount,
          durationMs,
          error: errorMessage,
        });
      } else {
        this.logger.log("info", "corridor.rate_collector.cycle_completed", {
          runCount: this._runCount,
          durationMs,
        });
      }
    }

    return {
      status: hasError ? "error" : "completed",
      runCount: this._runCount,
      skipCount: this._skipCount,
      durationMs: this._lastRunDurationMs,
      jitterMs,
      stepResults,
      error: errorMessage,
    };
  }
}

/**
 * Creates and starts a RateCollectorLoop.
 */
export function startRateCollectorLoop(options?: RateCollectorLoopOptions): RateCollectorLoop {
  const loop = new RateCollectorLoop(options);
  return loop.start();
}
