// Live data-fetching layer for the "latest real testnet payment" dashboard panel.
//
// Reads:
// 1. Latest nightly reference-corridor run from public GitHub REST API
// 2. Latest USDC payment into reference anchor receiving account GA4EGD3... from Horizon testnet

export const REFERENCE_RECEIVING_ACCOUNT =
  "GA4EGD3EGPUOYCOBJAPZ63MXMN4I3WS5QJ5BAAYR3SGFQOOU5HA4N4C3";

export const GITHUB_WORKFLOW_RUNS_URL =
  "https://api.github.com/repos/corridor-in-a-box/corridor-in-a-box/actions/workflows/reference-corridor.yml/runs?per_page=1";

export const HORIZON_TESTNET_PAYMENTS_URL = `https://horizon-testnet.stellar.org/accounts/${REFERENCE_RECEIVING_ACCOUNT}/payments?order=desc&limit=10`;

export interface WorkflowRunInfo {
  id: number;
  url: string;
  status: string;
  conclusion: string | null;
  displayStatus: "completed" | "failed" | "in_progress" | "held";
  createdAt: string;
  updatedAt: string;
}

export interface SettlePaymentInfo {
  txHash: string;
  amount: string;
  assetCode: string;
  createdAt: string;
  explorerUrl: string;
}

export interface LatestRealRunResult {
  ok: boolean;
  run: WorkflowRunInfo | null;
  settle: SettlePaymentInfo | null;
  trail: string[];
  runUnavailable: boolean;
  settleUnavailable: boolean;
  error?: string;
}

export const COMPLETED_REFERENCE_TRAIL = [
  "created",
  "quoted",
  "compliant",
  "opened",
  "verifying",
  "settling",
  "settled",
  "reconciling",
  "completed",
] as const;

export async function fetchLatestWorkflowRun(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; run: WorkflowRunInfo } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(GITHUB_WORKFLOW_RUNS_URL, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "corridor-in-a-box-web",
      },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      workflow_runs?: Array<{
        id: number;
        html_url: string;
        status: string;
        conclusion: string | null;
        created_at: string;
        updated_at: string;
      }>;
    };
    const latest = data.workflow_runs?.[0];
    if (!latest) {
      return { ok: false, error: "no runs found" };
    }

    let displayStatus: "completed" | "failed" | "in_progress" | "held" = "in_progress";
    if (latest.status === "completed") {
      displayStatus = latest.conclusion === "success" ? "completed" : "failed";
    } else if (latest.status === "waiting" || latest.status === "action_required") {
      displayStatus = "held";
    }

    return {
      ok: true,
      run: {
        id: latest.id,
        url: latest.html_url,
        status: latest.status,
        conclusion: latest.conclusion,
        displayStatus,
        createdAt: latest.created_at,
        updatedAt: latest.updated_at,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function fetchLatestSettlePayment(
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; settle: SettlePaymentInfo } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(HORIZON_TESTNET_PAYMENTS_URL);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      _embedded?: {
        records?: Array<{
          type?: string;
          to?: string;
          asset_code?: string;
          amount?: string;
          transaction_hash?: string;
          created_at?: string;
        }>;
      };
    };
    const records = data["_embedded"]?.records ?? [];
    const payment = records.find(
      (r) =>
        r.to === REFERENCE_RECEIVING_ACCOUNT &&
        (r.asset_code === "USDC" || !r.asset_code) &&
        r.transaction_hash,
    );
    if (!payment || !payment.transaction_hash) {
      return { ok: false, error: "no payment record found" };
    }

    return {
      ok: true,
      settle: {
        txHash: payment.transaction_hash,
        amount: payment.amount ?? "10.0000000",
        assetCode: payment.asset_code ?? "USDC",
        createdAt: payment.created_at ?? new Date().toISOString(),
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${payment.transaction_hash}`,
      },
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function fetchLatestRealRun(
  fetchImpl: typeof fetch = fetch,
): Promise<LatestRealRunResult> {
  const [runRes, settleRes] = await Promise.all([
    fetchLatestWorkflowRun(fetchImpl),
    fetchLatestSettlePayment(fetchImpl),
  ]);

  const run = runRes.ok ? runRes.run : null;
  const settle = settleRes.ok ? settleRes.settle : null;

  let trail: string[] = [...COMPLETED_REFERENCE_TRAIL];
  if (run && run.displayStatus === "failed") {
    trail = ["created", "quoted", "compliant", "opened", "failed"];
  } else if (run && run.displayStatus === "held") {
    trail = ["created", "quoted", "compliant", "opened", "verifying", "held"];
  }

  return {
    ok: runRes.ok && settleRes.ok,
    run,
    settle,
    trail,
    runUnavailable: !runRes.ok,
    settleUnavailable: !settleRes.ok,
    error: !runRes.ok
      ? `Workflow: ${runRes.error}`
      : !settleRes.ok
        ? `Horizon: ${settleRes.error}`
        : undefined,
  };
}
