# Inventory monitoring agent

A Mastra agent using a Gemini model inspects synthetic inventory events, raises one alert per low-stock cycle, and prepares a local replenishment draft. Events carry IDs and sequence numbers so repeats and stale counts cannot change stock twice. Effective stock includes units already on order; a threshold change can create or clear an alert.

## Run locally

Requires Node 22.13+ and npm.

```sh
npm ci
npm run build
npm run inventory -- init --state workspace.json
npm run inventory -- event --state workspace.json --id EV-101 --sku SKU-101 --sequence 101 --kind sale --value 4
npm run inventory -- inspect --state workspace.json --sku SKU-101
```

Set `GOOGLE_API_KEY` and an enabled explicit `INVENTORY_MODEL` in `google/<model>` format. No model fallback is selected. The normal run uses a managed source and a separate caller intent/write gate:

```sh
npm run inventory:state -- init --db workspace/inventory.db
npm run inventory:state -- event --db workspace/inventory.db --event-json '{"id":"EV-101","sku":"SKU-101","sequence":101,"kind":"sale","value":4}'
npm run inventory:state -- inspect --db workspace/inventory.db --sku SKU-101 > workspace/intent.json
npm run inventory -- run --db workspace/inventory.db --sku SKU-101 --task "Evaluate SKU-101 and prepare its current local draft, then inspect it" --allow-writes --intent-json "$(cat workspace/intent.json)"
```

For a read-only inspection, omit write permission and intent. `--model`/`--base-url` configure the explicit enabled Google model and native HTTPS `/v1beta` endpoint or an owned loopback HTTP provider. `--timeout-ms` sets10..300000milliseconds, `--output` selects private receipts. Real provider requests can incur cost. Automated checks use owned local HTTP and synthetic keys.

The Mastra tools inspect current item state, evaluate an alert and prepare a replenishment draft using the item's current revision. Evaluation and draft preparation require `--allow-writes`; no purchasing or vendor API exists. The CLI's `event` command is the synthetic external event seam. Stocktakes set an absolute quantity, sales and receipts change it, and threshold events change the trigger. Repeated event IDs and old sequences are rejected. An event after a draft marks that draft superseded, and the next draft must use the new revision.

Start an independent source from a fresh copy of `fixtures/starter.json`; preserve old source and evidence. The local JSON workspace is designed for sequential events, not concurrent production inventory. `npm test` covers the Mastra tool boundary, duplicate/stale events, effective stock, alert cycles, threshold changes and draft invalidation. These are offline checks, not a live Gemini run. Live provider and new Firedrill integration proofs remain pending.

The scoped argparse override removes the inherited `sprintf-js` dependency; a guarded install-time repair preserves js-yaml's legacy version option. See [scripts/README.md](scripts/README.md). The original dependency checkpoint passed fresh `npm ci`, seven checks and `npm audit` with zero findings at the 2026-10-15 snapshot. Current source checkpoint passes42checks; no new audit or native Gemini qualification is implied. This private repository has no license pending portfolio publication decisions.

Explore related applications in the [Firedrill example catalog](https://github.com/firedrill-tools/firedrill-example-catalog). Product and setup references: [Firedrill](https://firedrill.run/) and the [official developer documentation](https://docs.firedrill.run/). Use documentation matching the qualified release; this repository records its current integration limits above.

## Current source contract

The human-source JSON boundary accepts bounded regular, unshared files with exact typed items, safe quantities/effective sums/revisions/sequences and coherent thresholds/targets. It rejects duplicate original JSON keys, nonfinite/coerced fields, invalid UTF-8/Unicode, aliases and unsupported prior state. The starter fixture remains unchanged. On the first actual source effect, the source retains its exact original fixture bytes/hash and declared synthetic-human provenance, then records complete before/after/read/argument/result history. Every read validates complete transition replay against current items/events/alerts/drafts, preventing fabricated same-revision drafts or unexplained current stock. Historical alert/draft snapshots remain linked to their actual earlier state.

Each inventory event updates its low-stock cycle immediately. A recovery closes the earlier alert even if evaluation happens only after stock falls again; that next evaluation creates a new alert. Any actual event supersedes current drafts. Duplicate/stale/denied events, unchanged evaluations and repeated valid draft preparation preserve literal source bytes. Unsafe arithmetic is rejected before saving. Receipts are explicit synthetic quantity deltas; they leave the separately recorded on-order amount unchanged and do not acknowledge a supplier order. No supplier/order API exists.

A Workspace pins its original file descriptor until explicit close and checks physical source/root identity. Exclusive random0600staging and flushed replacement reject stale writers; source replacement and receipt publication are separate effects. Library callers must call Workspace.close() exactly once in a finally block. The private CLI and tests close their source owners.

This42check source checkpoint does not qualify normal model write authority. Genuine scoped current observations/exact caller intent, owned native Mastra/Gemini lifecycle/evidence, twelve coherent private cases/reset and fresh distributions are the next tasks in [PLAN.md](PLAN.md). The existing makeTools/Workspace methods remain explicit trusted synthetic-human/test seams. The normal entry point uses makeManagedTools and the managed source.

## Managed source and scoped tools

The managed backend adds genuine current read authority, exact caller targets and a separate write gate. Private inspection yields an initial intent; it never yields a model read capability. Normal tool handlers retain their own opaque read proofs privately and require a fresh inspection between alert evaluation and draft preparation. Source decisions derive current eligibility, active cycle and units atomically and retain exact before/after context and applied/unchanged/denied results. Real synthetic-human events can commit independently and invalidate older reads. Scope closes durably before draining; cancellation cannot block control-only revocation. Corrupt schema/header/locks remain unconfirmed closure, and damaged business/history is never repaired.

```sh
npm run build
npm run inventory:state -- init --db workspace/inventory.db
npm run inventory:state -- event --db workspace/inventory.db --event-json '{"id":"EV-101","sku":"SKU-101","sequence":101,"kind":"sale","value":4}'
npm run inventory:state -- inspect --db workspace/inventory.db --sku SKU-101
```

The database retains literal original fixture, source identity/UUID, exact SQLite schema and complete current replay. It owns an actual DatabaseSync and a retained source descriptor; library callers must close once. Init is exclusive. The67check source/backend/actual tool/private CLI checkpoint still leaves normal native Gemini execution, lifecycle evidence, twelve private cases and fresh distributions active. The normal launch now uses `makeManagedTools`; lifecycle failure qualification, twelve cases and distributions remain active.

## Owned native execution checkpoint

The normal `runMonitor`/CLI uses actual Mastra Agent.generate, public Google SDK2.0.85 and one owned Undici7.30.1pool. Whole original nonstream generateContent JSON is checked before SDK parsing: explicit STOP/index0, one model candidate, no block/error, bounded text/reasoning/signature metadata and at most one strict known inventory function. Native response/function IDs cannot replay. The actual SDK tool entry must match its own unused original function name and complete arguments before source reads or writes. Original and normalized SDK final text/tool calls remain separate. Source policy still derives all alert/draft effects. The router's OpenAI-compatible URL path is not used for native Google requests.

Private0700/0600 receipts are prepared before keys/resources. They retain whole original SQL images through verified content-addressed schema/header/raw-row blobs, original HTTP request/decoded response bytes/unknown fields, original versus SDK counters, actual tool/source observations, decisions and earlier acknowledgements. `expandSource` reconstructs and verifies each original image. Missing/invalid/zero counters remain distinct, cached/reasoning counters are not inferred from SDK defaults, and actual cost/purchase remain unknown. No SDK/client/model replacement option is supported.

82checks cover source/managed boundaries plus actual normal SDK/HTTP, original MAX_TOKENS/missing/duplicate/coerced arguments, original final failure after committed alert/draft, actual normal CLI and SIGINT/SIGTERM/SIGHUP, caller/parent/shared-deadline cancellation during held provider HTTP, missing key before allocation and original caller input frozen across launch. Scope is closed before abort/drain, then actual provider/source resources close once. Detailed close/recording/source failure and remaining original-response cases are still being qualified; twelve coherent private case/reset and fresh installations follow. Controlled local SDK outputs do not qualify live model semantics, billing or Firedrill.
