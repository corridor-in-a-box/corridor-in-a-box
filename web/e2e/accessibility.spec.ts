import { test, expect, type Page, type Route } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import generatedStates from "../lib/generated/states.json" with { type: "json" };
import type { PlannedRoutes, ReceiverField, RouteOption, RouteRequest } from "../lib/send";

// Accessibility checks for the testnet send app (#692, RFC 0004 §6): every step
// of the /send flow, stopped long enough for axe to judge it, with keyboard
// order and focus checked alongside, because "navigable" is not something axe
// can infer from markup alone.
//
// /send as deployed renders the app without a route planner, a field loader or
// a sender (@corridor/service offers none of them yet), so the flow stops after
// the first step there. The later steps are reached on /send/a11y-fixture: the
// same <SendApp> inside the same /send layout, with those three seams wired to
// fetches that these checks answer with `page.route`. No engine, service or
// network is involved. The page is a 404 unless the server was started with
// SEND_A11Y_FIXTURE=1, which playwright.config.ts does.
//
// The older /payments runner is checked at the end, as before.

/** axe's WCAG A, AA and 2.2 checks, plus its own best-practice rules. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function expectAccessible(page: Page, step: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    violations,
    `axe found issues at the "${step}" step:\n` +
      violations
        .map(
          (v) =>
            `  ${v.id} (${v.impact}, ${v.nodes.length} node(s)) — ${v.help}\n` +
            v.nodes
              .map((n) => `    ${n.target.join(" ")}: ${n.failureSummary}`)
              .join("\n"),
        )
        .join("\n"),
  ).toEqual([]);
}

/**
 * The accessible name of whatever holds focus: the text of the label that points
 * at it, else its own text. A tab order is only worth asserting if it is
 * described the way a screen reader would describe it.
 */
async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "";
    const id = el.getAttribute("id");
    const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    return (label?.textContent ?? el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
  });
}

/**
 * Hold every request matching `url` until the returned function is called, then
 * let `answer` reply. Against a fake that answers at once, a loading step would
 * be gone before axe finished looking at it.
 */
async function hold(
  page: Page,
  url: string,
  answer: (route: Route) => Promise<void>,
): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    await held;
    await answer(route);
  });
  return () => release();
}

// --- The send app (/send) ---------------------------------------------------

const FIXTURE_PAGE = "/send/a11y-fixture";
// What the fixture page's seams call. The first two exist only for the
// fixture; the third is the send app's real proxy route.
const ROUTES_URL = "**/send/a11y-fixture/routes";
const FIELDS_URL = "**/send/a11y-fixture/fields";
const PAYMENTS_URL = "**/api/send/payments";

const AMOUNT = "25.00";

const ui = {
  amount: (page: Page) => page.getByLabel("Amount", { exact: true }),
  sendIn: (page: Page) => page.getByLabel("Send in"),
  country: (page: Page) => page.getByLabel("Destination country"),
  arrivesIn: (page: Page) => page.getByLabel("Arrives in"),
  findRoutes: (page: Page) => page.getByRole("button", { name: "Find routes" }),
  findingRoutes: (page: Page) => page.getByRole("button", { name: "Finding routes…" }),
  routes: (page: Page) => page.getByRole("radio"),
  timer: (page: Page) => page.getByRole("timer", { name: "Time left on the locked price" }),
  recipient: (page: Page) => page.getByRole("region", { name: "Recipient details" }),
  field: (page: Page, label: string) =>
    ui.recipient(page).getByLabel(label, { exact: true }),
  send: (page: Page) => page.getByRole("button", { name: "Send", exact: true }),
  sending: (page: Page) => page.getByRole("button", { name: "Sending…" }),
  alert: (page: Page, title: string) =>
    page.getByRole("alert").filter({ has: page.getByRole("heading", { name: title }) }),
};

/**
 * Three ranked routes, one per price label, so every badge and every wording
 * RFC 0004 §2 gives is on screen at once. Built from the request the app sent,
 * so the assets match what the sender picked. The anchors are .example domains:
 * these are test fixtures, not anchors anyone runs.
 */
function plannedFor(req: RouteRequest, lockedForMs: number): PlannedRoutes {
  const source = req.sourceAmount.asset;
  const dest = req.destAsset;
  const options: RouteOption[] = [
    {
      corridorId: "fixture-locked",
      receivingDomain: "anchor-one.example",
      protocol: "sep31",
      price: { label: "locked", rate: "0.998", quoteId: "q-1", expiresAt: Date.now() + lockedForMs },
      recipientGets: { asset: dest, amount: "24.45" },
      fees: { asset: source, amount: "0.50" },
      reliability: 0.98,
      reasons: ["locked for 120 s"],
    },
    {
      corridorId: "fixture-indicative",
      receivingDomain: "anchor-two.example",
      protocol: "sep31",
      price: { label: "indicative", rate: "0.997" },
      recipientGets: { asset: dest, amount: "24.33" },
      fees: { asset: source, amount: "0.60" },
      reliability: 0.9,
      reasons: ["indicative rate from anchor-two.example"],
    },
    {
      corridorId: "fixture-estimated",
      receivingDomain: "anchor-three.example",
      protocol: "sep6",
      price: { label: "estimated", rate: "0.995", basis: "P25 of 1,912 samples, 7d" },
      recipientGets: { asset: dest, amount: "24.08" },
      fees: { asset: source, amount: "0.80" },
      reliability: 0.75,
      reasons: ["estimated from 1,912 samples over 7 d"],
    },
  ];
  return { options };
}

/**
 * One of each kind of field the form can draw: text, a choice list, a date, an
 * optional field with the anchor's description, and a document upload the app
 * can't send yet (optional, so it does not block Send).
 */
const FIELDS: ReceiverField[] = [
  { name: "first_name", label: "First name", optional: false, type: "string", source: "sep12" },
  { name: "last_name", label: "Last name", optional: false, type: "string", source: "sep12" },
  {
    name: "type",
    label: "Type",
    description: "The kind of bank account the payout goes to.",
    optional: false,
    choices: ["checking", "savings"],
    type: "string",
    source: "sep31-transaction",
  },
  { name: "birth_date", label: "Birth date", optional: false, type: "date", source: "sep12" },
  {
    name: "reference",
    label: "Reference",
    description: "Shown to the recipient with the payout.",
    optional: true,
    type: "string",
    source: "sep31-transaction",
  },
  { name: "photo_id_front", label: "Photo id front", optional: true, type: "binary", source: "sep12" },
];

/** Answer the planner with `body`, or with the three routes when none is given. */
function answerRoutes(opts: { lockedForMs?: number; body?: PlannedRoutes; status?: number } = {}) {
  return (route: Route) => {
    if (opts.status) return route.fulfill({ status: opts.status, json: { error: "unavailable" } });
    const req = route.request().postDataJSON() as RouteRequest;
    return route.fulfill({ json: opts.body ?? plannedFor(req, opts.lockedForMs ?? 120_000) });
  };
}

const answerFields = (route: Route) => route.fulfill({ json: FIELDS });
const answerSent = (route: Route) =>
  route.fulfill({ json: { ok: true, state: "completed", transactionId: "tx_fixture" } });

/** Open the fixture page with every seam answering successfully; tests override what they need. */
async function openSendFixture(page: Page, opts: { lockedForMs?: number } = {}) {
  await page.route(ROUTES_URL, answerRoutes(opts));
  await page.route(FIELDS_URL, answerFields);
  await page.route(PAYMENTS_URL, answerSent);
  const res = await page.goto(FIXTURE_PAGE);
  expect(
    res?.status(),
    `${FIXTURE_PAGE} is not served: start the server with SEND_A11Y_FIXTURE=1`,
  ).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Send a testnet payment" })).toBeVisible();
  await waitForHydration(page);
}

/**
 * Wait until React has hydrated the amount field. A page changed by hand before
 * then is re-rendered by React, which would quietly undo the change.
 */
async function waitForHydration(page: Page) {
  await expect
    .poll(() =>
      ui.amount(page).evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))),
    )
    .toBe(true);
}

/** Amount in, Find routes pressed. */
async function findRoutes(page: Page) {
  await ui.amount(page).fill(AMOUNT);
  await ui.findRoutes(page).click();
}

/** Through to the recipient fields of the best route. */
async function toRecipientDetails(page: Page) {
  await findRoutes(page);
  await expect(ui.routes(page)).toHaveCount(3);
  await expect(ui.field(page, "First name")).toBeVisible();
}

async function fillRecipient(page: Page) {
  await ui.field(page, "First name").fill("Ada");
  await ui.field(page, "Last name").fill("Obi");
  await ui.field(page, "Type").selectOption("checking");
  await ui.field(page, "Birth date").fill("1990-04-01");
}

test.describe("the send app (/send)", () => {
  test("as deployed: the form is labelled and in reading order, and the next step says why it stops", async ({
    page,
  }) => {
    await page.goto("/send");
    await expect(page.getByRole("heading", { level: 1, name: "Send a testnet payment" })).toBeVisible();
    await waitForHydration(page);
    await expect(page.getByRole("note", { name: "Testnet notice" })).toBeVisible();
    await expectAccessible(page, "amount and destination");

    // Every control reachable by Tab alone, in the order it is read: no focus
    // trap, and nothing only a mouse can reach. The intro's link is the last
    // stop before the form.
    await page.getByRole("link", { name: "payment runner" }).focus();
    for (const next of [ui.amount, ui.sendIn, ui.country, ui.arrivesIn, ui.findRoutes]) {
      await page.keyboard.press("Tab");
      await expect(next(page)).toBeFocused();
    }

    // Submitting from the keyboard works, and the page explains that routes
    // can't be listed rather than going quiet.
    await ui.amount(page).fill(AMOUNT);
    await ui.amount(page).press("Enter");
    await expect(page.getByRole("heading", { name: "Routes can't be listed here yet" })).toBeVisible();
    await expectAccessible(page, "routes unavailable");
  });

  test("an amount the form refuses is tied to the field, and focused", async ({ page }) => {
    await page.goto("/send");
    await waitForHydration(page);
    await ui.amount(page).fill("abc");
    await ui.findRoutes(page).click();

    // Focus moves to the field that has to be fixed rather than staying on the
    // button just pressed, and the error is read out as part of the field.
    await expect(ui.amount(page)).toBeFocused();
    await expect(ui.amount(page)).toHaveAttribute("aria-invalid", "true");
    await expect(ui.amount(page)).toHaveAccessibleDescription(/Use digits only/);
    await expectAccessible(page, "amount refused");
  });

  test("finding routes, the ranked routes with a locked price, and the recipient details", async ({
    page,
  }) => {
    await openSendFixture(page);
    await expectAccessible(page, "amount and destination (fixture)");

    const releaseRoutes = await hold(page, ROUTES_URL, answerRoutes());
    const releaseFields = await hold(page, FIELDS_URL, answerFields);
    await findRoutes(page);

    // While the planner is working the button says so and can't be pressed twice.
    await expect(ui.findingRoutes(page)).toBeDisabled();
    await expectAccessible(page, "finding routes");

    releaseRoutes();
    await expect(ui.routes(page)).toHaveCount(3);
    await expect(ui.routes(page).first()).toBeChecked();
    await expect(page.getByText("3 routes found.")).toBeAttached();
    await expect(ui.timer(page)).toBeVisible();
    // The best route is picked and its anchor's fields are on their way.
    await expect(ui.recipient(page)).toHaveAttribute("aria-busy", "true");
    await expectAccessible(page, "routes listed, recipient details loading");

    releaseFields();
    await expect(ui.field(page, "First name")).toBeVisible();
    await expect(ui.recipient(page)).toHaveAttribute("aria-busy", "false");
    await expect(ui.field(page, "Type")).toHaveAccessibleDescription(
      "The kind of bank account the payout goes to.",
    );
    await expectAccessible(page, "recipient details");
  });

  test("the routes are one radio group: arrows change the pick, Tab moves on to the fields", async ({
    page,
  }) => {
    await openSendFixture(page);
    await toRecipientDetails(page);

    const [first, second] = [ui.routes(page).nth(0), ui.routes(page).nth(1)];
    // Each option is announced by its anchor, its label and its price.
    await expect(first).toHaveAccessibleName(/anchor-one\.example locked Recipient gets 24\.45 USD/);
    await expect(second).toHaveAccessibleName(/anchor-two\.example indicative About 24\.33 USD/);

    await first.focus();
    await page.keyboard.press("ArrowDown");
    await expect(second).toBeFocused();
    await expect(second).toBeChecked();
    // An indicative price has no timer, and the new anchor's fields load in.
    await expect(ui.timer(page)).toHaveCount(0);
    await expect(ui.field(page, "First name")).toBeVisible();

    // One Tab leaves the group, then the fields follow in the order shown. An
    // optional field says so in its name, and the document upload is not a
    // control, so Tab skips it.
    for (const label of ["First name", "Last name", "Type", "Birth date"]) {
      await page.keyboard.press("Tab");
      await expect(ui.field(page, label)).toBeFocused();
    }
    await ui.field(page, "Reference (optional)").focus();
    await page.keyboard.press("Tab");
    await expect(ui.send(page)).toBeFocused();
    await expectAccessible(page, "second route picked");
  });

  test("Send with details missing: each error is tied to its field, and focus goes to the first", async ({
    page,
  }) => {
    await openSendFixture(page);
    await toRecipientDetails(page);
    await ui.send(page).click();

    const firstName = ui.field(page, "First name");
    await expect(firstName).toBeFocused();
    await expect(firstName).toHaveAttribute("aria-invalid", "true");
    await expect(firstName).toHaveAccessibleDescription("Enter the first name.");
    await expect(ui.field(page, "Birth date")).toHaveAttribute("aria-invalid", "true");
    // The optional field is left alone.
    await expect(ui.field(page, "Reference (optional)")).toHaveAttribute("aria-invalid", "false");
    await expectAccessible(page, "recipient details refused");
  });

  test("sending, then sent", async ({ page }) => {
    await openSendFixture(page);
    await toRecipientDetails(page);
    await fillRecipient(page);

    const release = await hold(page, PAYMENTS_URL, answerSent);
    await ui.send(page).click();
    await expect(ui.sending(page)).toBeDisabled();
    await expectAccessible(page, "sending");

    release();
    await expect(page.getByText("Payment sent.")).toBeVisible();
    // Sent once is sent: the button stays off so a second press can't repeat it.
    await expect(ui.send(page)).toBeDisabled();
    await expectAccessible(page, "sent");
  });

  test("a payment that fails offers the next step, and the keyboard can take it", async ({ page }) => {
    await openSendFixture(page);
    await page.route(PAYMENTS_URL, (route) =>
      route.fulfill({ status: 502, json: { error: "service_unreachable" } }),
    );
    await toRecipientDetails(page);
    await fillRecipient(page);
    await ui.send(page).click();

    const failed = ui.alert(page, "The payment failed");
    await expect(failed).toBeVisible();
    await expectAccessible(page, "payment failed");

    await failed.getByRole("button", { name: "Start a new payment" }).focus();
    await page.keyboard.press("Enter");
    await expect(ui.amount(page)).toBeFocused();
  });

  test("a locked price about to run out warns before it does", async ({ page }) => {
    await openSendFixture(page, { lockedForMs: 15_000 });
    await toRecipientDetails(page);
    await expect(page.getByText("This price is about to expire.")).toBeVisible();
    await expectAccessible(page, "locked price about to expire");
  });

  test("a locked price that has run out", async ({ page }) => {
    await openSendFixture(page, { lockedForMs: -1_000 });
    await findRoutes(page);

    const expired = ui.alert(page, "The locked price expired");
    await expect(expired).toBeVisible();
    await expect(expired.getByRole("button", { name: "Get a new price" })).toBeVisible();
    await expect(ui.send(page)).toBeDisabled();
    await expectAccessible(page, "locked price expired");
  });

  test("no route for this payment", async ({ page }) => {
    await openSendFixture(page);
    await page.route(ROUTES_URL, answerRoutes({ body: { options: [] } }));
    await findRoutes(page);

    const none = ui.alert(page, "No routes available");
    await expect(none).toBeVisible();
    await expectAccessible(page, "no routes");

    await none.getByRole("button", { name: "Change the payment" }).click();
    await expect(ui.amount(page)).toBeFocused();
  });

  test("every route ruled out, each with its reason", async ({ page }) => {
    await openSendFixture(page);
    await page.route(
      ROUTES_URL,
      answerRoutes({
        body: {
          options: [],
          dropped: [
            { route: "anchor-one.example", reason: "dropped: amount above max 10" },
            { route: "anchor-two.example", reason: "dropped: no price within 5 s" },
          ],
        },
      }),
    );
    await findRoutes(page);

    const dropped = ui.alert(page, "Every route was ruled out");
    await expect(dropped).toBeVisible();
    await expect(dropped.getByRole("listitem")).toHaveCount(2);
    await expectAccessible(page, "all routes dropped");
  });

  test("routes that can't be loaded, and trying again from the keyboard", async ({ page }) => {
    await openSendFixture(page);
    await page.route(ROUTES_URL, answerRoutes({ status: 500 }));
    await findRoutes(page);

    const failed = page.getByRole("alert").filter({ hasText: "Couldn't get routes right now." });
    await expect(failed).toBeVisible();
    await expectAccessible(page, "routes failed");

    await page.unroute(ROUTES_URL);
    await page.route(ROUTES_URL, answerRoutes());
    await failed.getByRole("button", { name: "Try again" }).focus();
    await page.keyboard.press("Enter");
    await expect(ui.routes(page)).toHaveCount(3);
  });

  test("recipient details that can't be loaded", async ({ page }) => {
    await openSendFixture(page);
    await page.route(FIELDS_URL, (route) => route.fulfill({ status: 500, json: { error: "unavailable" } }));
    await findRoutes(page);

    const failed = page
      .getByRole("alert")
      .filter({ hasText: "Couldn't load what this anchor asks for." });
    await expect(failed).toBeVisible();
    await expect(failed.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(ui.send(page)).toBeDisabled();
    await expectAccessible(page, "recipient details failed");
  });

  test.describe("in the dark theme", () => {
    test.use({ colorScheme: "dark" });

    test("the same steps keep their contrast", async ({ page }) => {
      await openSendFixture(page, { lockedForMs: 15_000 });
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
      await expectAccessible(page, "amount and destination (dark)");

      await toRecipientDetails(page);
      await expect(page.getByText("This price is about to expire.")).toBeVisible();
      await expectAccessible(page, "routes and recipient details (dark)");

      // A fresh plan with time on the clock, so the price can't run out while
      // the rest of the flow is walked.
      await page.route(ROUTES_URL, answerRoutes());
      await ui.findRoutes(page).click();
      await expect(page.getByText("This price is locked.")).toBeVisible();
      await expect(ui.field(page, "First name")).toBeVisible();

      await ui.send(page).click();
      await expect(ui.field(page, "First name")).toHaveAttribute("aria-invalid", "true");
      await expectAccessible(page, "recipient details refused (dark)");

      await page.route(PAYMENTS_URL, (route) =>
        route.fulfill({ status: 502, json: { error: "service_unreachable" } }),
      );
      await fillRecipient(page);
      await ui.send(page).click();
      await expect(ui.alert(page, "The payment failed")).toBeVisible();
      await expectAccessible(page, "payment failed (dark)");
    });
  });

  test("the checks above are not vacuous", async ({ page }) => {
    // A green run means axe judged this page with the real stylesheet applied,
    // not that it had nothing to say. So break the page on purpose and require
    // the checks to notice each break.
    await page.goto("/send");
    await waitForHydration(page);

    // 1. an input whose label is gone, 2. grey text that misses the AA ratio.
    await page.evaluate(() => {
      for (const label of document.querySelectorAll('label[for$="-amount"]')) {
        label.remove();
      }
      const faint = document.createElement("p");
      faint.textContent = "grey text on a white page";
      faint.style.color = "#a0a0a0";
      document.querySelector("main")?.append(faint);
    });

    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const ids = violations.map((v) => v.id);
    // The amount keeps its placeholder, which still names it, so axe files the
    // missing label under its best-practice rule rather than WCAG's. Either is
    // a failure of the gate.
    expect(
      ids.includes("label") || ids.includes("label-title-only"),
      `unlabelled input not caught: ${ids}`,
    ).toBe(true);
    expect(ids.includes("color-contrast"), `low contrast not caught: ${ids}`).toBe(true);

    // 3. the amount field stops being reachable by keyboard — precisely what the
    // tab-order check above exists to catch.
    await page.reload();
    await waitForHydration(page);
    await ui.amount(page).evaluate((el) => el.setAttribute("tabindex", "-1"));
    await page.getByRole("link", { name: "payment runner" }).focus();
    const reached: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      reached.push(await ui.amount(page).evaluate((el) => el === document.activeElement));
    }
    expect(reached.includes(true), "the amount field was still reached by Tab").toBe(false);
  });
});

// --- The payment runner (/payments) -----------------------------------------

// The engine caps a payment on a lane nobody has proven at 10 units (`run.ts`'s
// canary gate), and every corridor the demo serves is unproven. The form's own
// default of 100.00 is therefore refused before anything happens, so these
// checks send an amount that reaches the rest of the flow.
const RUNNER_AMOUNT = "5.00";

const runner = {
  corridor: (page: Page) => page.getByLabel("Corridor"),
  amount: (page: Page) => page.getByLabel("Source amount"),
  scenario: (page: Page) => page.getByLabel("Scenario"),
  idemKey: (page: Page) => page.getByLabel("Idempotency key"),
  run: (page: Page) => page.getByRole("button", { name: "Run payment" }),
  running: (page: Page) => page.getByRole("button", { name: "Running…" }),
  progress: (page: Page) => page.getByRole("region", { name: "Payment progress" }),
};

/** The state in the progress timeline's own badge — "waiting" until it can see the run. */
function timelineState(page: Page) {
  return runner.progress(page).locator("span").first();
}

// Read from the engine's generated state list rather than copied here, so a new
// terminal state cannot leave these checks waiting for something that never ends.
const TERMINAL = generatedStates.terminal;

/** Wait until the timeline has stopped polling because the run reached an end state. */
async function waitForTerminalState(page: Page) {
  await expect
    .poll(
      async () => TERMINAL.includes((await timelineState(page).textContent())?.trim() ?? ""),
      { timeout: 40_000 },
    )
    .toBe(true);
}

/** Start a run with the given scenario and wait for the timeline to catch it. */
async function startRun(page: Page, scenario?: string) {
  await runner.amount(page).fill(RUNNER_AMOUNT);
  if (scenario) await runner.scenario(page).selectOption({ label: scenario });
  await runner.run(page).click();
  await expect(runner.progress(page)).toBeVisible();
}

test.describe("the payment runner (/payments)", () => {
  // The demo store lives as long as the server does, so a repeated key replays
  // an earlier check's run instead of walking the flow. Each test gets its own.
  const run = Math.random().toString(36).slice(2, 8);

  test.beforeEach(async ({ page }, testInfo) => {
    await page.goto("/payments");
    await expect(page.getByRole("heading", { level: 1, name: "Run a payment" })).toBeVisible();
    await runner.idemKey(page).fill(`a11y-${testInfo.testId}-${run}`);
  });

  test("the form is labelled, and its controls follow in reading order", async ({ page }) => {
    await expectAccessible(page, "runner form");

    await runner.corridor(page).focus();
    const order = [await focusedName(page)];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      order.push(await focusedName(page));
    }
    expect(order).toEqual([
      "Corridor",
      "Source amount",
      "Scenario",
      "Idempotency key",
      "Run payment",
      "Reset",
    ]);
  });

  test("submitting, then following the payment to completed", async ({ page }) => {
    const release = await hold(page, "**/api/payments", (route) =>
      route.request().method() === "POST" ? route.continue() : route.fallback(),
    );
    await runner.amount(page).fill(RUNNER_AMOUNT);
    await runner.run(page).click();

    // While the request is in flight the run is not stored yet, so the timeline
    // says "waiting" and the controls are disabled — a keyboard user must still
    // be told what the page is doing.
    await expect(runner.running(page)).toBeDisabled();
    await expect(timelineState(page)).toHaveText("waiting");
    await expectAccessible(page, "runner submitting");

    release();
    await waitForTerminalState(page);
    await expect(timelineState(page)).toHaveText("completed");
    await expectAccessible(page, "runner completed");
  });

  test("a settlement that fails and comes back refunded", async ({ page }) => {
    await startRun(page, "Settlement retries then fails");
    await waitForTerminalState(page);
    await expect(timelineState(page)).toHaveText("refunded");
    await expectAccessible(page, "runner refunded");
  });

  test("an amount the engine refuses is tied to the field, and focused", async ({ page }) => {
    await runner.amount(page).fill("abc");
    await runner.run(page).click();

    await expect(runner.amount(page)).toHaveAttribute("aria-invalid", "true");
    await expect(runner.amount(page)).toBeFocused();
    await expectAccessible(page, "runner amount refused");
  });
});
