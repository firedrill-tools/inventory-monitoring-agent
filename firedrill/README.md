# Firedrill agent-first integration

The optional toolchain pins released `@firedrill-run/cli` and `@firedrill-run/sdk` **2.2.2** (October 19, 2026), Node 22+. The app retains its locked native provider/framework dependencies.

## Prepare and run

From the repository root:

```sh
npm ci
npm run build
npm ci --prefix firedrill --ignore-scripts --no-audit --no-fund
npm test --prefix firedrill
node firedrill/node_modules/@firedrill-run/cli/bin/firedrill.mjs validate firedrill/scenario.json --json --non-interactive
```

Validation is offline. In a human terminal, use the same CLI `init` to authorize/select the actual project/environment. Automation uses protected `FIREDRILL_TOKEN`, `FIREDRILL_PROJECT_ID`, `FIREDRILL_ENVIRONMENT_ID`. Model operations independently need `GOOGLE_API_KEY` and an enabled `INVENTORY_MODEL` or recipe model parameter. Do not put credentials in recipes.

After scope and provider budget are authorized:

```sh
node firedrill/simulate.mjs --preview
node firedrill/simulate.mjs
```

The bounded sequential recipe initializes the actual private inventory case and invokes the normal compiled inventory CLI, public Mastra Agent.generate and owned native Google SDK transport. No model/client factory or scripted fallback is inserted. Explicit SKU IDs and task remain separate from write permission. Existing exact current cycle/source/read proofs, safe quantity arithmetic and alert/draft transactions remain authoritative. Receipt events remain declared quantity deltas and do not invent supplier orders or change separately recorded onOrder values. Starter/blocker tasks are read-only native calls; busy inspection uses actual case APIs with no model call.

`allowWrites` is an independent required literal caller boolean: false requires null intent; true requires exact bounded caller intent, revalidated by the application before any model work. No permission/intent is inferred from task, fixture, private references or prior human history. The recipe grants no writes. Inspect original current source and construct an explicitly reviewed intent before intentionally allowing fictional effects; all existing operation/source/revision/final verification guards remain active.

Each attempt saves validated outer run/attempt/scenario IDs in private `.runs/firedrill/attempt-*/invocation.json` before creating a distinct absent workspace leaf. Complete actual private initialization/inspection objects are saved outside the model workspace as 0600 files, with byte count and SHA-256 in a bounded summary (64 MiB retained-file bound, separate from 4 MiB command output). Private reference/seed/control/oracle fields stay outside model input. The actual initialized database is checked inside its owned workspace. Earlier DB/WAL/SHM, decisions/effects and receipts are never reset by a new attempt. Application failure is nonzero with original stdout/stderr/run directory; preserve earlier effects and unknown cleanup/publication/billing outcomes. Paths are local evidence, not uploaded platform artifacts. Existing native cancellation/close/source lifecycle remains authoritative; local termination does not establish rollback or provider cancellation. Current ID-only invocation excludes controller assessment data, rejects unsupported Tool bindings and removes operator/CI credentials before dispatch.

## MCP and recovery

Configure remote OAuth operator MCP at **https://mcp.firedrill.run/mcp** using [host setup](https://docs.firedrill.run/guides/coding-agents). MCP prepares, queues and inspects; the local SDK/CLI executes the command target. Host OAuth and execution login are separate. Use `--run BATCH_ID` to attach queued work, `--resume OPERATION_ID` after uncertainty, and `--result BATCH_ID` to read retained results. Preserve SDK journals and local evidence. These scripts retain public SDK diagnostics and whole-batch exit status; a new simulation starts new work.

CI and the fresh locked source archive run offline integration tests with actual private business state and the native missing-key boundary. They establish wiring and cleanup, not live model quality, platform persistence, or uploaded captures. The observation recipe defines no grader/gate. Authenticated persisted happy/negative runs, paid model quality/cost, publication and licensing remain separate gates.

References: [SDK](https://docs.firedrill.run/sdk/typescript), [command targets](https://docs.firedrill.run/guides/callbacks), [operator MCP](https://docs.firedrill.run/guides/control-mcp), [CI](https://docs.firedrill.run/guides/ci).

Native models use the application’s `google/<model>` format. Full source and fresh npm consumer qualification keep the application package separately locked; the optional Firedrill clients remain a private prefix toolchain.
