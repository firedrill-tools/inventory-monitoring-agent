import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Workspace } from "./workspace.js";

export function makeTools(workspace: Workspace, allowWrites: boolean) {
  const inspectInventory = createTool({
    id: "inspect-inventory",
    description:
      "Read current SKU counts, on-order quantities, thresholds, revisions, alerts and drafts.",
    inputSchema: z.object({ sku: z.string().optional() }),
    execute: async ({ sku }) => workspace.inspect(sku),
  });
  const evaluateInventory = createTool({
    id: "evaluate-inventory",
    description:
      "Evaluate one SKU against its current threshold and create at most one alert per low-stock cycle. Requires write authorization.",
    inputSchema: z.object({ sku: z.string().min(1) }),
    execute: async ({ sku }) =>
      allowWrites
        ? workspace.evaluate(sku)
        : { ok: false, error: "writes_not_authorized" },
  });
  const prepareReplenishment = createTool({
    id: "prepare-replenishment",
    description:
      "Prepare a local replenishment draft for a low-stock SKU after checking its current revision and on-order quantity. Never purchases stock.",
    inputSchema: z.object({
      sku: z.string().min(1),
      expectedRevision: z.number().int(),
    }),
    execute: async ({ sku, expectedRevision }) =>
      allowWrites
        ? workspace.prepare(sku, expectedRevision)
        : { ok: false, error: "writes_not_authorized" },
  });
  return { inspectInventory, evaluateInventory, prepareReplenishment };
}

export { runMonitor } from "./runtime.js";
