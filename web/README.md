# corridor-in-a-box — web

A small Next.js (App Router, Tailwind v4) frontend for the engine:

- **Dashboard** — every corridor in `../corridors/` with its liveness —
  `proven` / `verified` / `unverified` / `not runnable` — where only `proven` and
  `verified` count as runnable (`lib/corridors.ts`, using `liveness()` from
  `@corridor/manifest`). Above them, the anchors attested in the on-chain registry
  (`lib/registry.ts`) behind a Testnet / Mainnet switch. Every card names the network its
  numbers come from, `?network=public` links straight to the mainnet view, and
  `STELLAR_NETWORK` (`testnet` by default) sets which one opens first. A network with no
  registry in `../contracts/deployments.json` says so, apart from a registry that could not
  be read or one that is empty.
- **Run a payment** — drive a payment through the engine and watch it walk the
  state machine, including the idempotent replay.
- **Docs** — overview, getting started, architecture, HTTP API, key management, and
  why not Anchor Platform? (the six pages in `lib/docs.ts`).

The corridor data and the state-machine list are not hand-copied. They are
generated into `lib/generated/` from the manifests and
`packages/engine/src/state.ts`. After editing either, run `pnpm gen:web-data`
from the repo root and commit the result. CI fails when the committed files
are out of date.

Since [#80](https://github.com/corridor-in-a-box/corridor-in-a-box/pull/80) `web/` is
its own pnpm workspace root (`web/pnpm-workspace.yaml`, with its own lockfile), so
it builds and runs on its own — gated by its own CI job (`pnpm lint` +
`pnpm typecheck` + `pnpm build`, see `.github/workflows/ci.yml`)
rather than by the monorepo's test/lint gate. Lint is
[oxlint](https://oxc.rs/docs/guide/usage/linter.html)
(`.oxlintrc.json`), not ESLint: ESLint's TypeScript parser refuses TS 7, while
oxlint parses TS with its own Rust parser.

## Develop

```bash
cd web
pnpm install
pnpm dev      # http://localhost:3000
```

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test:a11y   # axe over every step of the /send flow (Playwright)
```

`test:a11y` builds and serves the production app itself (`playwright.config.ts`), so
it is slow on a cold machine and needs `pnpm exec playwright install --with-deps
chromium` once. It runs against `e2e/accessibility.spec.ts`. It is a local check and
does not run in CI.

`/send` renders the send app without a route planner, a field loader or a sender,
because `@corridor/service` offers none of them yet, so the flow stops after the
first step there. The later steps are checked on `/send/a11y-fixture`: the same app
with those three wired to fetches the spec answers with `page.route`. That page is
a 404 unless the server runs with `SEND_A11Y_FIXTURE=1`, which the Playwright config
sets; a server you start yourself for the checks needs it too.

## How it talks to the engine

By default the **Run a payment** page calls a local API route
(`app/api/payments/route.ts`) that invokes the real `@corridor/engine` with
in-memory mock anchor and settlement adapters. The scenario selector exercises
the happy path, quote expiry, settlement retries, and reconciliation recovery;
no live anchor endpoints or funds are used. `web/` keeps its own pnpm lockfile
but resolves engine, adapter-kit, manifest, router, and types from their source
using `tsconfig.json` paths and Next's `transpilePackages`.

To drive the **real** engine, run `@corridor/service` and set:

```bash
CORRIDOR_SERVICE_URL=http://localhost:8080      # the route proxies POST /payments here
CORRIDOR_SERVICE_API_KEY=…                        # optional; if the service requires Bearer auth
```

When `CORRIDOR_SERVICE_URL` is set the route forwards to the real service and
relays its response; the demo-only scenario field is removed from the proxied
request.
