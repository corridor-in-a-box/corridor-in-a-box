import { PaymentRunner } from "@/components/PaymentRunner";

export const metadata = {
  title: "Run a payment — corridor-in-a-box",
};

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ corridor?: string }>;
}) {
  const { corridor } = await searchParams;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Run a payment</h1>
        <p className="mt-1 max-w-2xl text-secondary-text">
          Drive a payment through the engine and watch it walk the state machine. This runs the real{" "}
          <code>@corridor/engine</code> with mock anchor and settlement adapters; no funds move and
          nothing touches the network. Set <code>CORRIDOR_SERVICE_URL</code> to drive a real{" "}
          <code>@corridor/service</code>.
        </p>
      </div>
      <PaymentRunner initialCorridor={corridor} />
    </div>
  );
}
