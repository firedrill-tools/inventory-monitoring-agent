/** Pure sequential inventory transitions; never places an order. */
import { canonical, hash, keys, validText } from "./json.js";

export type Item = {
  sku: string;
  name: string;
  quantity: number;
  onOrder: number;
  threshold: number;
  target: number;
  sequence: number;
  revision: number;
  alertActive: boolean;
};
export type InventoryEvent = {
  id: string;
  sku: string;
  sequence: number;
  kind: "sale" | "receipt" | "stocktake" | "threshold";
  value: number;
};
export type RecordedEvent = InventoryEvent & { source: Item; after: Item };
export type Alert = {
  id: string;
  sku: string;
  revision: number;
  source: Item;
  status: "active" | "closed";
  closedBy: string | null;
};
export type Draft = {
  id: string;
  sku: string;
  alertId: string;
  revision: number;
  units: number;
  status: "current" | "superseded";
  source: Item;
  alert: Alert;
};
export type Business = {
  items: Item[];
  events: RecordedEvent[];
  alerts: Alert[];
  drafts: Draft[];
};
export type Result = {
  ok: boolean;
  error?: string;
  item?: Item;
  status?: string;
  alertId?: string;
  units?: number;
  draft?: Draft;
};
export type Action =
  | { kind: "event"; args: InventoryEvent }
  | { kind: "evaluate"; args: { sku: string } }
  | { kind: "prepare"; args: { sku: string; expectedRevision: number } };

export function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/[A-Z]/.test(value[0] ?? "") ||
    !/^[A-Z][A-Z0-9_-]{0,63}$/.test(value)
  )
    throw new Error("canonical inventory identifier required");
}
export function integer(value: unknown, minimum = 0): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    Object.is(value, -0)
  )
    throw new Error("exact safe inventory integer required");
}
export function item(value: unknown): asserts value is Item {
  keys(value, [
    "sku",
    "name",
    "quantity",
    "onOrder",
    "threshold",
    "target",
    "sequence",
    "revision",
    "alertActive",
  ]);
  identifier(value.sku);
  validText(value.name, 1, 200);
  for (const k of ["quantity", "onOrder", "sequence"]) integer(value[k]);
  for (const k of ["threshold", "target", "revision"]) integer(value[k], 1);
  if (
    typeof value.alertActive !== "boolean" ||
    (value.threshold as number) > (value.target as number) ||
    !Number.isSafeInteger(
      (value.quantity as number) + (value.onOrder as number),
    )
  )
    throw new Error("coherent effective stock/threshold/target/flag required");
}
export const effective = (row: Item) => row.quantity + row.onOrder;
export const eligible = (row: Item) => effective(row) < row.threshold;
export function business(value: unknown): asserts value is Business {
  keys(value, ["items", "events", "alerts", "drafts"]);
  for (const [k, maximum] of [
    ["items", 128],
    ["events", 1024],
    ["alerts", 512],
    ["drafts", 512],
  ] as const) {
    if (!Array.isArray(value[k]) || (value[k] as unknown[]).length > maximum)
      throw new Error("bounded complete inventory arrays required");
  }
  const rows = value.items as unknown[];
  if (!rows.length) throw new Error("inventory items required");
  rows.forEach(item);
  if (new Set((rows as Item[]).map((r) => r.sku)).size !== rows.length)
    throw new Error("duplicate inventory SKU");
}
export function transition(
  original: Business,
  action: Action,
): { business: Business; result: Result; read: Item | null } {
  business(original);
  keys(action, ["kind", "args"]);
  if (action.kind === "event") {
    keys(action.args, ["id", "sku", "sequence", "kind", "value"]);
    identifier(action.args.id);
    identifier(action.args.sku);
    integer(action.args.sequence, 1);
    integer(action.args.value);
    if (
      !["sale", "receipt", "stocktake", "threshold"].includes(action.args.kind)
    )
      throw new Error("exact inventory event kind required");
  } else if (action.kind === "evaluate") {
    keys(action.args, ["sku"]);
    identifier(action.args.sku);
  } else if (action.kind === "prepare") {
    keys(action.args, ["sku", "expectedRevision"]);
    identifier(action.args.sku);
    integer(action.args.expectedRevision, 1);
  } else throw new Error("unknown inventory action");
  const data = structuredClone(original),
    row = data.items.find((r) => r.sku === action.args.sku),
    read = row ? structuredClone(row) : null;
  const denied = (error: string) => ({
    business: data,
    result: { ok: false, error },
    read,
  });
  if (!row) return denied("unknown_sku");
  if (action.kind === "event") {
    const event = action.args,
      prior = data.events.find((e) => e.id === event.id);
    if (prior) {
      const payload = Object.fromEntries(
        ["id", "sku", "sequence", "kind", "value"].map((k) => [
          k,
          prior[k as keyof RecordedEvent],
        ]),
      );
      return denied(
        canonical(payload) === canonical(event)
          ? "duplicate_event"
          : "event_id_reused",
      );
    }
    if (event.sequence <= row.sequence) return denied("stale_sequence");
    if (event.kind === "sale" && event.value > row.quantity)
      return denied("insufficient_stock");
    if (
      event.kind === "threshold" &&
      (!event.value || event.value > row.target)
    )
      return denied("invalid_threshold");
    if (row.revision === Number.MAX_SAFE_INTEGER)
      throw new Error("revision_exhausted");
    if (event.kind === "sale") row.quantity -= event.value;
    // Receipt is an explicit synthetic quantity delta. It neither acknowledges
    // a supplier order nor changes the separately recorded onOrder amount.
    if (event.kind === "receipt") row.quantity += event.value;
    if (event.kind === "stocktake") row.quantity = event.value;
    if (event.kind === "threshold") row.threshold = event.value;
    row.sequence = event.sequence;
    row.revision++;
    item(row); // Includes safe quantity/effective arithmetic before any save.
    if (!eligible(row)) {
      row.alertActive = false;
      for (const alert of data.alerts.filter(
        (a) => a.sku === row.sku && a.status === "active",
      )) {
        alert.status = "closed";
        alert.closedBy = event.id;
      }
    }
    for (const draft of data.drafts.filter(
      (d) => d.sku === row.sku && d.status === "current",
    ))
      draft.status = "superseded";
    data.events.push({ ...event, source: read!, after: structuredClone(row) });
    business(data);
    return {
      business: data,
      result: { ok: true, item: structuredClone(row) },
      read,
    };
  }
  if (action.kind === "evaluate") {
    if (!eligible(row))
      return {
        business: data,
        result: { ok: true, status: "above_threshold" },
        read,
      };
    if (!row.alertActive) {
      const alert: Alert = {
        id: `ALT-${data.alerts.length + 1}`,
        sku: row.sku,
        revision: row.revision,
        source: read!,
        status: "active",
        closedBy: null,
      };
      row.alertActive = true;
      data.alerts.push(alert);
      business(data);
      return {
        business: data,
        result: {
          ok: true,
          status: "alert_created",
          alertId: alert.id,
          units: row.target - effective(row),
        },
        read,
      };
    }
    const alert = [...data.alerts]
      .reverse()
      .find((a) => a.sku === row.sku && a.status === "active");
    if (!alert) throw new Error("active inventory alert has no original cycle");
    return {
      business: data,
      result: {
        ok: true,
        status: "already_alerted",
        alertId: alert.id,
        units: row.target - effective(row),
      },
      read,
    };
  }
  if (row.revision !== action.args.expectedRevision)
    return denied("stale_revision");
  if (!eligible(row) || !row.alertActive) return denied("not_below_threshold");
  const alert = [...data.alerts]
    .reverse()
    .find((a) => a.sku === row.sku && a.status === "active");
  if (!alert) throw new Error("current active inventory cycle required");
  const prior = data.drafts.find(
    (d) =>
      d.sku === row.sku &&
      d.revision === row.revision &&
      d.status === "current",
  );
  if (prior)
    return {
      business: data,
      result: { ok: true, draft: structuredClone(prior) },
      read,
    };
  const draft: Draft = {
    id: `DR-${data.drafts.length + 1}`,
    sku: row.sku,
    alertId: alert.id,
    revision: row.revision,
    units: row.target - effective(row),
    status: "current",
    source: read!,
    alert: structuredClone(alert),
  };
  for (const prior of data.drafts.filter(
    (d) => d.sku === row.sku && d.status === "current",
  ))
    prior.status = "superseded";
  data.drafts.push(draft);
  business(data);
  return {
    business: data,
    result: { ok: true, draft: structuredClone(draft) },
    read,
  };
}
export const businessHash = (value: Business) => hash(canonical(value));
