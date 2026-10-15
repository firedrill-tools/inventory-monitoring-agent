import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";

export type Item = { sku: string; name: string; quantity: number; onOrder: number; threshold: number; target: number; sequence: number; revision: number; alertActive: boolean };
export type InventoryEvent = { id: string; sku: string; sequence: number; kind: "sale" | "receipt" | "stocktake" | "threshold"; value: number };
export type InventoryState = { items: Item[]; events: InventoryEvent[]; alerts: { id: string; sku: string; revision: number }[];
  drafts: { id: string; sku: string; alertId: string; revision: number; units: number; status: "current" | "superseded" }[] };
export function loadState(file: string): InventoryState {
  const data = JSON.parse(readFileSync(resolve(file), "utf8")) as InventoryState;
  if (![data.items, data.events, data.alerts, data.drafts].every(Array.isArray)) throw new Error("invalid inventory state");
  return data;
}
export class Workspace {
  file: string;
  constructor(file: string) { this.file = resolve(file); loadState(this.file); }
  save(data: InventoryState) { const temp = `${this.file}.${process.pid}.tmp`; writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`); renameSync(temp, this.file); }
  inspect(sku?: string) {
    const data = loadState(this.file);
    return { items: data.items.filter((item) => !sku || item.sku === sku).map((item) => ({ ...item, effective: item.quantity + item.onOrder,
      eligible: item.quantity + item.onOrder < item.threshold })), alerts: data.alerts.filter((item) => !sku || item.sku === sku),
      drafts: data.drafts.filter((item) => !sku || item.sku === sku) };
  }
  applyEvent(event: InventoryEvent): { ok: boolean; error?: string; item?: Item } {
    const data = loadState(this.file);
    const prior = data.events.find((item) => item.id === event.id);
    if (prior) return JSON.stringify(prior) === JSON.stringify(event) ? { ok: false, error: "duplicate_event" } : { ok: false, error: "event_id_reused" };
    const item = data.items.find((row) => row.sku === event.sku);
    if (!item) return { ok: false, error: "unknown_sku" };
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= item.sequence) return { ok: false, error: "stale_sequence" };
    if (!Number.isSafeInteger(event.value) || event.value < 0 || !["sale", "receipt", "stocktake", "threshold"].includes(event.kind)) return { ok: false, error: "invalid_event" };
    if (event.kind === "sale" && event.value > item.quantity) return { ok: false, error: "insufficient_stock" };
    if (event.kind === "sale") item.quantity -= event.value;
    if (event.kind === "receipt") item.quantity += event.value;
    if (event.kind === "stocktake") item.quantity = event.value;
    if (event.kind === "threshold") {
      if (!event.value || event.value > item.target) return { ok: false, error: "invalid_threshold" };
      item.threshold = event.value;
    }
    item.sequence = event.sequence; item.revision += 1;
    for (const draft of data.drafts.filter((row) => row.sku === item.sku && row.status === "current")) draft.status = "superseded";
    data.events.push(event); this.save(data);
    return { ok: true, item };
  }
  evaluate(sku: string): { ok: boolean; status?: string; alertId?: string; units?: number; error?: string } {
    const data = loadState(this.file); const item = data.items.find((row) => row.sku === sku);
    if (!item) return { ok: false, error: "unknown_sku" };
    const effective = item.quantity + item.onOrder;
    if (effective >= item.threshold) {
      if (item.alertActive) { item.alertActive = false; this.save(data); }
      return { ok: true, status: "above_threshold" };
    }
    if (!item.alertActive) {
      item.alertActive = true;
      data.alerts.push({ id: `ALT-${data.alerts.length + 1}`, sku, revision: item.revision });
      this.save(data);
      return { ok: true, status: "alert_created", alertId: data.alerts.at(-1)!.id, units: item.target - effective };
    }
    return { ok: true, status: "already_alerted", alertId: data.alerts.filter((alert) => alert.sku === sku).at(-1)!.id,
      units: item.target - effective };
  }
  prepare(sku: string, expectedRevision: number): { ok: boolean; error?: string; draft?: InventoryState["drafts"][number] } {
    const data = loadState(this.file); const item = data.items.find((row) => row.sku === sku);
    if (!item) return { ok: false, error: "unknown_sku" };
    if (item.revision !== expectedRevision) return { ok: false, error: "stale_revision" };
    const effective = item.quantity + item.onOrder;
    if (effective >= item.threshold || !item.alertActive) return { ok: false, error: "not_below_threshold" };
    const alert = data.alerts.filter((row) => row.sku === sku).at(-1)!;
    const prior = data.drafts.find((row) => row.sku === sku && row.revision === item.revision);
    if (prior) return { ok: true, draft: prior };
    for (const old of data.drafts.filter((row) => row.sku === sku && row.status === "current")) old.status = "superseded";
    const draft = { id: `DR-${data.drafts.length + 1}`, sku, alertId: alert.id, revision: item.revision,
      units: item.target - effective, status: "current" as const };
    data.drafts.push(draft); this.save(data);
    return { ok: true, draft };
  }
}
