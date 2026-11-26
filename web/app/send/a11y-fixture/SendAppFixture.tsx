"use client";

import { SendApp, type SendAppProps } from "@/components/send/SendApp";
import type { LoadReceiverFields, PlanRoutes, PlannedRoutes, ReceiverField, SendPayment } from "@/lib/send";

// The seams <SendApp> takes, as plain fetches for the accessibility spec to
// answer (see page.tsx). The routes and fields URLs have no handler on the
// server: the service does not plan routes or read anchor fields yet, so only
// the spec's `page.route` answers them, and unanswered they fail into the app's
// own error screens. Sending goes to the real /api/send/payments path, which
// the spec also answers.
const FIXTURE_ROUTES_URL = "/send/a11y-fixture/routes";
const FIXTURE_FIELDS_URL = "/send/a11y-fixture/fields";
const SEND_URL = "/api/send/payments";

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

const planRoutes: PlanRoutes = async (request) =>
  (await postJson(FIXTURE_ROUTES_URL, request)) as PlannedRoutes;

const loadReceiverFields: LoadReceiverFields = async (option) =>
  (await postJson(FIXTURE_FIELDS_URL, option)) as ReceiverField[];

const sendPayment: SendPayment = async ({ option, destinationFields, customerFields }) => {
  await postJson(SEND_URL, {
    corridorId: option.corridorId,
    quoteId: option.price.quoteId,
    destinationFields,
    customerFields,
  });
};

export function SendAppFixture(props: Pick<SendAppProps, "destinations" | "sourceAssets">) {
  return (
    <SendApp
      {...props}
      planRoutes={planRoutes}
      loadReceiverFields={loadReceiverFields}
      sendPayment={sendPayment}
    />
  );
}
