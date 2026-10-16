/** Actual Mastra tools keep genuine read capabilities private to their scope. */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  ManagedWorkspace,
  type Credential,
  type ReadProof,
} from "./managed.js";
import type { Action } from "./domain.js";

const skuSchema = z.string().regex(/^[A-Z][A-Z0-9_-]{0,63}$/);
type Read = ReturnType<ManagedWorkspace["observe"]>;
type Decision = ReturnType<ManagedWorkspace["commit"]>;
export function makeManagedTools(
  source: ManagedWorkspace,
  credential: Credential,
  hooks: {
    beforeCall?: (name: string, args: Record<string, unknown>) => void;
    onError?: (error: unknown) => void;
    afterCall?: (
      name: string,
      args: Record<string, unknown>,
      result: unknown,
    ) => void;
    onRead?: (value: Read) => void;
    onDecision?: (value: Decision) => void;
  } = {},
) {
  const latest = new Map<string, ReadProof>();
  function mutate(action: Exclude<Action, { kind: "event" }>) {
    const op = source.currentOperation(credential);
    if (!op.allowWrites) return { ok: false, error: "writes_not_authorized" };
    const proof = latest.get(action.args.sku);
    if (!proof) return { ok: false, error: "current_read_required" };
    latest.delete(action.args.sku);
    const result = source.commit(credential, proof, action);
    hooks.onDecision?.(result);
    return result.result;
  }
  const inspectInventory = createTool({
    id: "inspect-inventory",
    description:
      "Read actual current inventory for selected caller SKUs. Reinspect before each evaluation or draft and after any event. Read capabilities stay private.",
    inputSchema: z.object({ sku: skuSchema.optional() }).strict(),
    execute: async ({ sku }) => {
      hooks.beforeCall?.("inspectInventory", sku === undefined ? {} : { sku });
      const op = source.currentOperation(credential),
        targets =
          sku === undefined ? op.intent.targets.map((t) => t.sku) : [sku];
      const values = targets.map((target) => {
        const read = source.observe(credential, target);
        latest.set(target, read.proof);
        hooks.onRead?.(read);
        return read.value;
      });
      return {
        items: values.map((v) => ({
          ...v.item,
          effective: v.effective,
          eligible: v.eligible,
        })),
        alerts: values.flatMap((v) => v.alerts),
        drafts: values.flatMap((v) => v.drafts),
      };
    },
  });
  const evaluateInventory = createTool({
    id: "evaluate-inventory",
    description:
      "Evaluate selected current effective stock against its current threshold and record at most one alert per low-stock cycle. Requires own fresh inspection and separate write authorization.",
    inputSchema: z.object({ sku: skuSchema }).strict(),
    execute: async ({ sku }) => {
      hooks.beforeCall?.("evaluateInventory", { sku });
      return mutate({ kind: "evaluate", args: { sku } });
    },
  });
  const prepareReplenishment = createTool({
    id: "prepare-replenishment",
    description:
      "Prepare an exact local replenishment draft from current effective stock, target, active alert and revision. Reinspect after evaluating. Never places a purchase order.",
    inputSchema: z
      .object({
        sku: skuSchema,
        expectedRevision: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    execute: async ({ sku, expectedRevision }) => {
      hooks.beforeCall?.("prepareReplenishment", { sku, expectedRevision });
      return mutate({ kind: "prepare", args: { sku, expectedRevision } });
    },
  });
  for (const [name, tool] of Object.entries({
    inspectInventory,
    evaluateInventory,
    prepareReplenishment,
  })) {
    const execute = tool.execute!;
    tool.execute = (async (...args: any[]) => {
      try {
        const result = await (execute as any)(...args);
        hooks.afterCall?.(name, args[0], result);
        return result;
      } catch (error) {
        hooks.onError?.(error);
        throw error;
      }
    }) as typeof tool.execute;
  }
  return { inspectInventory, evaluateInventory, prepareReplenishment };
}
