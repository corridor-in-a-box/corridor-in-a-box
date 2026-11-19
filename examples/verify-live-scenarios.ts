// Runs ALL live testnet failure scenarios against the reference anchor:
// - Issue #676: Amounts outside anchor limits
// - Issue #673: Anchor asks for customer info (NEEDS_INFO)
// - Issue #675: Anchor down during the flow (outage & recovery)
// - Issue #674: Payout fails and anchor refunds

import { fileURLToPath } from "node:url";
import { runLimitsScenario } from "./verify-scenario-limits.js";
import { runNeedsInfoScenario } from "./verify-scenario-needs-info.js";
import { runAnchorDownScenario } from "./verify-scenario-anchor-down.js";
import { runRefundScenario } from "./verify-scenario-refund.js";
import { EXIT_NOT_COMPLETED, EXIT_OK } from "../packages/cli/src/wire.js";

export async function runAllLiveScenarios(): Promise<void> {
  console.log("==================================================================");
  console.log(" Running all live testnet failure scenarios (#676, #675, #674, #673)");
  console.log("==================================================================");

  console.log("\n>>> [1/4] Scenario #676: Amounts outside anchor limits");
  await runLimitsScenario();

  console.log("\n>>> [2/4] Scenario #673: Anchor asks for customer info (NEEDS_INFO)");
  await runNeedsInfoScenario();

  console.log("\n>>> [3/4] Scenario #675: Anchor down during the flow");
  await runAnchorDownScenario();

  console.log("\n>>> [4/4] Scenario #674: Payout fails and anchor refunds");
  await runRefundScenario();

  console.log("\n==================================================================");
  console.log("✓ All 4 live testnet failure scenarios passed successfully!");
  console.log("==================================================================");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runAllLiveScenarios()
    .then(() => process.exit(EXIT_OK))
    .catch((err) => {
      console.error(`\n✗ Live scenarios suite failed: ${String(err)}`);
      process.exit(EXIT_NOT_COMPLETED);
    });
}
