import { describe, expect, it } from "vitest";
import {
  fetchLatestWorkflowRun,
  fetchLatestSettlePayment,
  fetchLatestRealRun,
  REFERENCE_RECEIVING_ACCOUNT,
} from "../web/lib/latest-run";

function mockResponse(data: unknown, status = 200, ok = true): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => data,
  } as unknown as Response;
}

describe("fetchLatestWorkflowRun", () => {
  it("fetches and parses a successful completed nightly run", async () => {
    const fakeFetch: typeof fetch = async () =>
      mockResponse({
        workflow_runs: [
          {
            id: 43969161708,
            html_url:
              "https://github.com/corridor-in-a-box/corridor-in-a-box/actions/runs/43969161708",
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-19T05:43:00Z",
            updated_at: "2026-11-19T05:51:00Z",
          },
        ],
      });

    const res = await fetchLatestWorkflowRun(fakeFetch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.run.id).toBe(43969161708);
    expect(res.run.displayStatus).toBe("completed");
    expect(res.run.url).toContain("43969161708");
    expect(res.run.createdAt).toBe("2026-11-19T05:43:00Z");
  });

  it("identifies a failed latest run and does not fall back to an older run", async () => {
    const fakeFetch: typeof fetch = async () =>
      mockResponse({
        workflow_runs: [
          {
            id: 44000000000,
            html_url:
              "https://github.com/corridor-in-a-box/corridor-in-a-box/actions/runs/44000000000",
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-20T05:43:00Z",
            updated_at: "2026-11-20T05:45:00Z",
          },
        ],
      });

    const res = await fetchLatestWorkflowRun(fakeFetch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.run.id).toBe(44000000000);
    expect(res.run.displayStatus).toBe("failed");
    expect(res.run.conclusion).toBe("failure");
  });

  it("identifies a held or action_required run", async () => {
    const fakeFetch: typeof fetch = async () =>
      mockResponse({
        workflow_runs: [
          {
            id: 44000000001,
            html_url:
              "https://github.com/corridor-in-a-box/corridor-in-a-box/actions/runs/44000000001",
            status: "action_required",
            conclusion: null,
            created_at: "2026-11-20T05:43:00Z",
            updated_at: "2026-11-20T05:43:30Z",
          },
        ],
      });

    const res = await fetchLatestWorkflowRun(fakeFetch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.run.displayStatus).toBe("held");
  });

  it("handles GitHub API unreachable or error status", async () => {
    const fakeFetch: typeof fetch = async () => mockResponse({}, 500, false);

    const res = await fetchLatestWorkflowRun(fakeFetch);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("500");
    }
  });

  it("handles network thrown exception", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("Network timeout");
    };

    const res = await fetchLatestWorkflowRun(fakeFetch);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Network timeout");
    }
  });
});

describe("fetchLatestSettlePayment", () => {
  it("fetches and parses the latest USDC payment to the reference anchor", async () => {
    const fakeFetch: typeof fetch = async () =>
      mockResponse({
        _embedded: {
          records: [
            {
              type: "payment",
              to: REFERENCE_RECEIVING_ACCOUNT,
              asset_code: "USDC",
              amount: "10.0000000",
              transaction_hash:
                "81c4642216b884100b34fa018462bb9cd7587886307d59d923dccbf87011b630",
              created_at: "2026-11-19T05:48:00Z",
            },
          ],
        },
      });

    const res = await fetchLatestSettlePayment(fakeFetch);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.settle.amount).toBe("10.0000000");
    expect(res.settle.assetCode).toBe("USDC");
    expect(res.settle.txHash).toBe(
      "81c4642216b884100b34fa018462bb9cd7587886307d59d923dccbf87011b630",
    );
    expect(res.settle.explorerUrl).toContain("stellar.expert");
    expect(res.settle.explorerUrl).toContain(res.settle.txHash);
  });

  it("handles Horizon unreachable or error status", async () => {
    const fakeFetch: typeof fetch = async () => mockResponse({}, 503, false);

    const res = await fetchLatestSettlePayment(fakeFetch);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("503");
    }
  });

  it("handles missing payments in Horizon records", async () => {
    const fakeFetch: typeof fetch = async () =>
      mockResponse({
        _embedded: {
          records: [],
        },
      });

    const res = await fetchLatestSettlePayment(fakeFetch);
    expect(res.ok).toBe(false);
  });
});

describe("fetchLatestRealRun combined", () => {
  it("combines both live sources into a completed run trail", async () => {
    const fakeFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes("api.github.com")) {
        return mockResponse({
          workflow_runs: [
            {
              id: 12345,
              html_url:
                "https://github.com/corridor-in-a-box/corridor-in-a-box/actions/runs/12345",
              status: "completed",
              conclusion: "success",
              created_at: "2026-11-19T05:00:00Z",
              updated_at: "2026-11-19T05:10:00Z",
            },
          ],
        });
      }
      return mockResponse({
        _embedded: {
          records: [
            {
              to: REFERENCE_RECEIVING_ACCOUNT,
              asset_code: "USDC",
              amount: "10.0000000",
              transaction_hash: "txhash1234567890",
              created_at: "2026-11-19T05:05:00Z",
            },
          ],
        },
      });
    };

    const res = await fetchLatestRealRun(fakeFetch);
    expect(res.ok).toBe(true);
    expect(res.runUnavailable).toBe(false);
    expect(res.settleUnavailable).toBe(false);
    expect(res.run?.id).toBe(12345);
    expect(res.run?.displayStatus).toBe("completed");
    expect(res.settle?.amount).toBe("10.0000000");
    expect(res.trail[res.trail.length - 1]).toBe("completed");
  });

  it("marks failed run trail when latest workflow run failed", async () => {
    const fakeFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes("api.github.com")) {
        return mockResponse({
          workflow_runs: [
            {
              id: 99999,
              html_url:
                "https://github.com/corridor-in-a-box/corridor-in-a-box/actions/runs/99999",
              status: "completed",
              conclusion: "failure",
              created_at: "2026-11-20T05:00:00Z",
              updated_at: "2026-11-20T05:05:00Z",
            },
          ],
        });
      }
      return mockResponse({ _embedded: { records: [] } });
    };

    const res = await fetchLatestRealRun(fakeFetch);
    expect(res.run?.displayStatus).toBe("failed");
    expect(res.trail[res.trail.length - 1]).toBe("failed");
  });

  it("handles source unreachable gracefully with unavailable flags", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("DNS resolution failed");
    };

    const res = await fetchLatestRealRun(fakeFetch);
    expect(res.ok).toBe(false);
    expect(res.runUnavailable).toBe(true);
    expect(res.settleUnavailable).toBe(true);
    expect(res.run).toBeNull();
    expect(res.settle).toBeNull();
  });
});
