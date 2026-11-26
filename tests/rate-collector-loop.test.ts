import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RateCollectorLoop,
  startRateCollectorLoop,
  parseCollectorInterval,
  parseCollectorJitter,
  defaultSleep,
  DEFAULT_COLLECTOR_INTERVAL_MS,
  DEFAULT_MAX_JITTER_MS,
  type CollectorStep,
  type Logger,
} from "@corridor/engine";

describe("RateCollectorLoop (#593)", () => {
  let logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;
  let testLogger: Logger;

  beforeEach(() => {
    logs = [];
    testLogger = {
      log: (level, msg, fields) => {
        logs.push({ level, msg, fields });
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Config parsing", () => {
    it("parses interval from milliseconds string", () => {
      expect(parseCollectorInterval("60000")).toBe(60_000);
      expect(parseCollectorInterval("900000")).toBe(900_000);
    });

    it("parses interval from seconds string when ms is not provided", () => {
      expect(parseCollectorInterval(undefined, "300")).toBe(300_000);
      expect(parseCollectorInterval("", "900")).toBe(900_000);
    });

    it("falls back to default interval when variables are empty or invalid", () => {
      expect(parseCollectorInterval()).toBe(DEFAULT_COLLECTOR_INTERVAL_MS);
      expect(parseCollectorInterval("not-a-number")).toBe(DEFAULT_COLLECTOR_INTERVAL_MS);
      expect(parseCollectorInterval("-500")).toBe(DEFAULT_COLLECTOR_INTERVAL_MS);
      expect(parseCollectorInterval("", "")).toBe(DEFAULT_COLLECTOR_INTERVAL_MS);
    });

    it("parses jitter from milliseconds string", () => {
      expect(parseCollectorJitter("2000")).toBe(2_000);
      expect(parseCollectorJitter("0")).toBe(0);
    });

    it("falls back to default jitter when empty or invalid", () => {
      expect(parseCollectorJitter()).toBe(DEFAULT_MAX_JITTER_MS);
      expect(parseCollectorJitter("invalid")).toBe(DEFAULT_MAX_JITTER_MS);
      expect(parseCollectorJitter("-100")).toBe(DEFAULT_MAX_JITTER_MS);
      expect(parseCollectorJitter("")).toBe(DEFAULT_MAX_JITTER_MS);
    });
  });

  describe("Overlap guard", () => {
    it("skips a tick if a previous collection run is still in flight", async () => {
      let resolveStep1: () => void = () => {};
      const step1Promise = new Promise<void>((resolve) => {
        resolveStep1 = resolve;
      });

      let executionCount = 0;
      const steps: CollectorStep[] = [
        {
          name: "slow_step",
          run: async () => {
            executionCount++;
            await step1Promise;
            return { collected: 10 };
          },
        },
      ];

      const loop = new RateCollectorLoop({
        intervalMs: 10_000,
        maxJitterMs: 0,
        steps,
        logger: testLogger,
        runOnStart: false,
      });

      // Launch first tick (runs asynchronously and waits on resolveStep1)
      const firstTickPromise = loop.tick();
      expect(loop.isExecuting).toBe(true);

      // Attempt second tick while first is still executing
      const secondTickResult = await loop.tick();

      expect(secondTickResult.status).toBe("skipped_overlap");
      expect(secondTickResult.skipped).toBe(true);
      expect(loop.skipCount).toBe(1);
      expect(loop.runCount).toBe(0);

      // Verify warning log for overlap
      const overlapLog = logs.find((l) => l.msg === "corridor.rate_collector.skipped_overlap");
      expect(overlapLog).toBeDefined();
      expect(overlapLog?.level).toBe("warn");

      // Finish first tick
      resolveStep1();
      const firstTickResult = await firstTickPromise;

      expect(firstTickResult.status).toBe("completed");
      expect(executionCount).toBe(1);
      expect(loop.isExecuting).toBe(false);
      expect(loop.runCount).toBe(1);

      // Third tick should now succeed normally
      const thirdTickResult = await loop.tick();
      expect(thirdTickResult.status).toBe("completed");
      expect(executionCount).toBe(2);
      expect(loop.runCount).toBe(2);
      expect(loop.skipCount).toBe(1);
    });
  });

  describe("Jitter behavior", () => {
    it("applies random jitter within maxJitterMs", async () => {
      const sleeps: number[] = [];
      const mockSleep = async (ms: number) => {
        sleeps.push(ms);
      };

      const loop = new RateCollectorLoop({
        maxJitterMs: 5000,
        randomFn: () => 0.6, // 0.6 * 5000 = 3000 ms
        sleepFn: mockSleep,
        runCollector: async () => {},
        logger: testLogger,
      });

      const res = await loop.tick();
      expect(res.status).toBe("completed");
      expect(res.jitterMs).toBe(3000);
      expect(sleeps).toEqual([3000]);

      const jitterLog = logs.find((l) => l.msg === "corridor.rate_collector.jitter_delay");
      expect(jitterLog?.fields?.jitterMs).toBe(3000);
    });

    it("applies zero jitter when maxJitterMs is 0", async () => {
      const sleeps: number[] = [];
      const mockSleep = async (ms: number) => {
        sleeps.push(ms);
      };

      const loop = new RateCollectorLoop({
        maxJitterMs: 0,
        sleepFn: mockSleep,
        runCollector: async () => {},
      });

      const res = await loop.tick();
      expect(res.jitterMs).toBe(0);
      expect(sleeps).toEqual([]);
    });

    it("aborts tick if stopped during jitter delay", async () => {
      let abortSignal: AbortSignal | undefined;
      const loop = new RateCollectorLoop({
        maxJitterMs: 5000,
        randomFn: () => 0.5,
        sleepFn: (_ms, signal) => {
          abortSignal = signal;
          return new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        runCollector: async () => {
          throw new Error("Should not execute steps if aborted in jitter");
        },
        logger: testLogger,
      });

      loop.start();
      expect(loop.isExecuting).toBe(true);

      // Stop during jitter sleep
      await loop.stop();

      expect(abortSignal?.aborted).toBe(true);
      expect(loop.isExecuting).toBe(false);
      expect(loop.isRunning).toBe(false);
    });
  });

  describe("Graceful shutdown", () => {
    it("stops scheduling new runs and waits for in-flight step to finish", async () => {
      let stepFinished = false;
      let resolveStep: () => void = () => {};
      const stepPromise = new Promise<void>((resolve) => {
        resolveStep = resolve;
      });

      const loop = new RateCollectorLoop({
        intervalMs: 100,
        maxJitterMs: 0,
        runOnStart: false,
        runCollector: async () => {
          await stepPromise;
          stepFinished = true;
        },
        logger: testLogger,
      });

      loop.start();
      expect(loop.isRunning).toBe(true);

      // Trigger a tick
      const tickPromise = loop.tick();
      expect(loop.isExecuting).toBe(true);

      // Initiate stop while execution is running
      let stopResolved = false;
      const stopPromise = loop.stop().then(() => {
        stopResolved = true;
      });

      // Stop must wait for in-flight execution to finish
      expect(stopResolved).toBe(false);
      expect(stepFinished).toBe(false);

      // Finish in-flight execution
      resolveStep();
      await tickPromise;
      await stopPromise;

      expect(stepFinished).toBe(true);
      expect(stopResolved).toBe(true);
      expect(loop.isRunning).toBe(false);
      expect(loop.isExecuting).toBe(false);

      const drainLog = logs.find((l) => l.msg === "corridor.rate_collector.draining");
      expect(drainLog).toBeDefined();

      const stopLog = logs.find((l) => l.msg === "corridor.rate_collector.stopped");
      expect(stopLog).toBeDefined();
    });

    it("calling stop() when not running is a safe no-op", async () => {
      const loop = new RateCollectorLoop();
      await expect(loop.stop()).resolves.toBeUndefined();
    });
  });

  describe("Step execution and error resilience", () => {
    it("runs all registered steps sequentially and captures their results", async () => {
      const executed: string[] = [];
      const steps: CollectorStep[] = [
        {
          name: "step_a",
          run: async () => {
            executed.push("step_a");
            return { collected: 5 };
          },
        },
        {
          name: "step_b",
          run: async () => {
            executed.push("step_b");
            return { collected: 8 };
          },
        },
      ];

      const loop = new RateCollectorLoop({
        maxJitterMs: 0,
        steps,
      });

      const res = await loop.tick();
      expect(res.status).toBe("completed");
      expect(executed).toEqual(["step_a", "step_b"]);
      expect(res.stepResults?.["step_a"]).toEqual({ collected: 5 });
      expect(res.stepResults?.["step_b"]).toEqual({ collected: 8 });
    });

    it("resiliently catches and logs step failure without crashing the loop", async () => {
      const steps: CollectorStep[] = [
        {
          name: "failing_step",
          run: async () => {
            throw new Error("Horizon connection timeout");
          },
        },
        {
          name: "passing_step",
          run: async () => {
            return { collected: 3 };
          },
        },
      ];

      const loop = new RateCollectorLoop({
        maxJitterMs: 0,
        steps,
        logger: testLogger,
      });

      const res = await loop.tick();
      expect(res.status).toBe("error");
      expect(res.error).toBe("Horizon connection timeout");
      expect(loop.isExecuting).toBe(false);
      expect(loop.runCount).toBe(1);

      const errLog = logs.find((l) => l.msg === "corridor.rate_collector.step_failed");
      expect(errLog?.fields?.step).toBe("failing_step");
      expect(errLog?.fields?.error).toBe("Horizon connection timeout");

      // Verify that subsequent ticks can execute
      const secondTick = await loop.tick();
      expect(secondTick.runCount).toBe(2);
    });

    it("catches runCollector callback failure", async () => {
      const loop = new RateCollectorLoop({
        maxJitterMs: 0,
        runCollector: async () => {
          throw new Error("Generic failure in collector callback");
        },
        logger: testLogger,
      });

      const res = await loop.tick();
      expect(res.status).toBe("error");
      expect(res.error).toBe("Generic failure in collector callback");
      expect(loop.isExecuting).toBe(false);
    });
  });

  describe("Stats and metrics reporting", () => {
    it("reports stats and metrics correctly", async () => {
      const metricCalls: Array<{ type: string; name: string; val?: number }> = [];
      const testMetrics = {
        increment: (name: string) => {
          metricCalls.push({ type: "inc", name });
        },
        timing: (name: string, val: number) => {
          metricCalls.push({ type: "timing", name, val });
        },
      };

      const loop = new RateCollectorLoop({
        maxJitterMs: 0,
        runCollector: async () => {},
        metrics: testMetrics,
        now: () => 1700000000000,
      });

      expect(loop.stats.isRunning).toBe(false);
      expect(loop.stats.isExecuting).toBe(false);
      expect(loop.stats.runCount).toBe(0);

      await loop.tick();

      expect(loop.stats.runCount).toBe(1);
      expect(loop.stats.lastRunStartedAt).toBe(1700000000000);
      expect(loop.stats.lastRunCompletedAt).toBe(1700000000000);

      const runMetric = metricCalls.find((m) => m.name === "corridor.rate_collector.runs");
      expect(runMetric).toBeDefined();
    });

    it("startRateCollectorLoop helper starts loop and returns instance", async () => {
      const loop = startRateCollectorLoop({
        runOnStart: false,
      });
      expect(loop.isRunning).toBe(true);
      // Calling start() again when running is a no-op
      expect(loop.start()).toBe(loop);
      await loop.stop();
      expect(loop.isRunning).toBe(false);
    });

    it("triggers tick via setInterval when advancing timer", async () => {
      vi.useFakeTimers();
      try {
        let tickCount = 0;
        const loop = new RateCollectorLoop({
          intervalMs: 1000,
          maxJitterMs: 0,
          runOnStart: false,
          runCollector: async () => {
            tickCount++;
          },
        });

        loop.start();
        expect(tickCount).toBe(0);

        await vi.advanceTimersByTimeAsync(1000);
        expect(tickCount).toBe(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(tickCount).toBe(2);

        await loop.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("breaks step loop if aborted during steps execution", async () => {
      const controller = new AbortController();
      const executed: string[] = [];
      const steps: CollectorStep[] = [
        {
          name: "step_1",
          run: async () => {
            executed.push("step_1");
            controller.abort();
          },
        },
        {
          name: "step_2",
          run: async () => {
            executed.push("step_2");
          },
        },
      ];

      const loop = new RateCollectorLoop({
        maxJitterMs: 0,
        steps,
      });
      // @ts-expect-error accessing private abort controller for test
      loop._abortController = controller;

      const res = await loop.tick();
      expect(res.status).toBe("completed");
      expect(executed).toEqual(["step_1"]);
      expect(res.stepResults?.["step_2"]).toBeUndefined();
    });

    it("records error metrics when metrics is provided and step throws", async () => {
      const metricCalls: Array<{ type: string; name: string; val?: number }> = [];
      const testMetrics = {
        increment: (name: string) => {
          metricCalls.push({ type: "inc", name });
        },
        timing: (name: string, val: number) => {
          metricCalls.push({ type: "timing", name, val });
        },
      };

      const loop = new RateCollectorLoop({
        maxJitterMs: 0,
        runCollector: async () => {
          throw "non-error step exception";
        },
        metrics: testMetrics,
        logger: testLogger,
      });

      const res = await loop.tick();
      expect(res.status).toBe("error");
      expect(res.error).toBe("non-error step exception");

      const errMetric = metricCalls.find((m) => m.name === "corridor.rate_collector.errors");
      expect(errMetric).toBeDefined();
    });

    it("handles in-flight rejection cleanly when stopping", async () => {
      const loop = new RateCollectorLoop({
        maxJitterMs: 0,
        runOnStart: false,
        runCollector: async () => {
          throw new Error("step failure");
        },
      });

      loop.start();
      const tickPromise = loop.tick();
      await loop.stop();
      await tickPromise;
      expect(loop.isRunning).toBe(false);
    });
  });

  describe("defaultSleep helper", () => {
    it("resolves immediately if signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(defaultSleep(10000, controller.signal)).resolves.toBeUndefined();
    });

    it("resolves when abort is signaled during sleep", async () => {
      const controller = new AbortController();
      const p = defaultSleep(10000, controller.signal);
      controller.abort();
      await expect(p).resolves.toBeUndefined();
    });
  });
});
