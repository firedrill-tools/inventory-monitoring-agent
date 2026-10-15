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

Set `GOOGLE_API_KEY` and an enabled `INVENTORY_MODEL` in `google/<model>` format, then run:

```sh
npm run inventory -- run --state workspace.json --task "Evaluate SKU-101 and prepare a replenishment draft if its current effective stock is below threshold" --allow-writes
```

The Mastra tools inspect current item state, evaluate an alert and prepare a replenishment draft using the item's current revision. Evaluation and draft preparation require `--allow-writes`; no purchasing or vendor API exists. The CLI's `event` command is the synthetic external event seam. Stocktakes set an absolute quantity, sales and receipts change it, and threshold events change the trigger. Repeated event IDs and old sequences are rejected. An event after a draft marks that draft superseded, and the next draft must use the new revision.

Reset with a fresh `workspace.json` copied from `fixtures/starter.json`. The local JSON workspace is designed for sequential events, not concurrent production inventory. `npm test` covers the Mastra tool boundary, duplicate/stale events, effective stock, alert cycles, threshold changes and draft invalidation. These are offline checks, not a live Gemini run. Live provider and new Firedrill integration proofs remain pending.

`npm audit` currently reports five moderate advisories in Mastra's transitive `gray-matter → js-yaml → argparse → sprintf-js` chain. `npm audit --audit-level=high` passes; a compatible upstream fix is pending. This private repository has no license pending portfolio publication decisions.

Explore related applications in the [Firedrill example catalog](https://github.com/firedrill-tools/firedrill-example-catalog). Product and setup references: [Firedrill](https://firedrill.run/) and the [official developer documentation](https://docs.firedrill.run/). Use documentation matching the qualified release; this repository records its current integration limits above.
