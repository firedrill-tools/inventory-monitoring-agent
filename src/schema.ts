/** Original human-source history; no model read/write capability is imported. */
import {
  business,
  businessHash,
  transition,
  type Action,
  type Business,
  type Item,
  type Result,
} from "./domain.js";
import { canonical, hash, keys, MAX_BYTES, parseJSON } from "./json.js";

export type History = {
  sequence: number;
  kind: Action["kind"];
  args: Action["args"];
  read: Item;
  before_sha256: string;
  after_sha256: string;
  result: Result;
};
export type Origin = {
  fixture_base64: string;
  fixture_sha256: string;
  provenance: {
    kind: "explicit_synthetic_human_source";
    prior_model: null;
    prior_human_authentication: null;
    actual_purchase: null;
  };
};
export type InventoryState = Business & {
  origin?: Origin;
  history?: History[];
};
export const PROVENANCE: Origin["provenance"] = {
  kind: "explicit_synthetic_human_source",
  prior_model: null,
  prior_human_authentication: null,
  actual_purchase: null,
};
export const projection = (value: InventoryState): Business => ({
  items: value.items,
  events: value.events,
  alerts: value.alerts,
  drafts: value.drafts,
});
function initial(value: unknown): Business {
  business(value);
  if (
    value.events.length ||
    value.alerts.length ||
    value.drafts.length ||
    value.items.some((r) => r.alertActive)
  )
    throw new Error(
      "initial inventory needs no unsupported prior history or active alert",
    );
  return value;
}
export function validateState(value: unknown): InventoryState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("original inventory object required");
  const data = value as InventoryState;
  if (!Object.hasOwn(data, "origin") && !Object.hasOwn(data, "history"))
    return initial(data);
  keys(data, ["items", "events", "alerts", "drafts", "origin", "history"]);
  business(projection(data));
  keys(data.origin, ["fixture_base64", "fixture_sha256", "provenance"]);
  if (
    typeof data.origin.fixture_base64 !== "string" ||
    typeof data.origin.fixture_sha256 !== "string" ||
    canonical(data.origin.provenance) !== canonical(PROVENANCE)
  )
    throw new Error("original synthetic source provenance required");
  const raw = Buffer.from(data.origin.fixture_base64, "base64");
  if (
    raw.length > MAX_BYTES ||
    raw.toString("base64") !== data.origin.fixture_base64 ||
    hash(raw) !== data.origin.fixture_sha256
  )
    throw new Error("original inventory fixture bytes/hash differ");
  let current = initial(parseJSON(raw));
  if (
    !Array.isArray(data.history) ||
    !data.history.length ||
    data.history.length > 2048
  )
    throw new Error("bounded complete source authoring history required");
  for (let n = 0; n < data.history.length; n++) {
    const step = data.history[n];
    keys(step, [
      "sequence",
      "kind",
      "args",
      "read",
      "before_sha256",
      "after_sha256",
      "result",
    ]);
    const action = { kind: step.kind, args: step.args } as Action;
    if (step.sequence !== n + 1 || step.before_sha256 !== businessHash(current))
      throw new Error("complete consecutive inventory history required");
    const next = transition(current, action);
    if (
      canonical(next.read) !== canonical(step.read) ||
      canonical(next.result) !== canonical(step.result) ||
      businessHash(next.business) !== step.after_sha256 ||
      step.before_sha256 === step.after_sha256
    )
      throw new Error(
        "original inventory history contradicts actual source transition",
      );
    current = next.business;
  }
  if (canonical(current) !== canonical(projection(data)))
    throw new Error("current inventory differs from complete original history");
  return data;
}
export function humanTransition(
  original: InventoryState,
  raw: Buffer,
  action: Action,
): { state: InventoryState; result: Result; changed: boolean } {
  validateState(original);
  const before = projection(original),
    next = transition(before, action);
  if (canonical(before) === canonical(next.business))
    return { state: original, result: next.result, changed: false };
  const origin = original.origin ?? {
    fixture_base64: raw.toString("base64"),
    fixture_sha256: hash(raw),
    provenance: PROVENANCE,
  };
  const state: InventoryState = {
    ...next.business,
    origin: structuredClone(origin),
    history: [
      ...structuredClone(original.history ?? []),
      {
        sequence: (original.history?.length ?? 0) + 1,
        kind: action.kind,
        args: structuredClone(action.args),
        read: next.read!,
        before_sha256: businessHash(before),
        after_sha256: businessHash(next.business),
        result: structuredClone(next.result),
      },
    ],
  };
  validateState(state);
  return { state, result: next.result, changed: true };
}
