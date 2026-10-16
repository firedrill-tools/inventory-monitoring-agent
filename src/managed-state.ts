/** Complete original managed SQL and genuine current inventory authority. */
import { DatabaseSync } from "node:sqlite";
import {
  type Action,
  type Business,
  type Item,
  type Result,
  businessHash,
  effective,
  eligible,
  identifier,
  integer,
  item,
  transition,
} from "./domain.js";
import { canonical, hash, keys, parseJSON } from "./json.js";
import { projection, validateState } from "./schema.js";

export const APPLICATION_ID = 0x4644494e,
  SCHEMA_VERSION = 1,
  MAX_DATABASE_BYTES = 64 * 1024 * 1024;
export const TABLES = {
  metadata:
    "CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL) STRICT",
  business:
    "CREATE TABLE business (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL) STRICT",
  operations:
    "CREATE TABLE operations (id TEXT PRIMARY KEY, token_sha256 TEXT NOT NULL UNIQUE, document TEXT NOT NULL) STRICT",
  observations:
    "CREATE TABLE observations (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, operation_id TEXT NOT NULL, document TEXT NOT NULL) STRICT",
  decisions:
    "CREATE TABLE decisions (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL UNIQUE, operation_id TEXT, document TEXT NOT NULL) STRICT",
  seed_state:
    "CREATE TABLE seed_state (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL) STRICT",
};
export const LIMITS = {
  operations: 128,
  observations: 1024,
  decisions: 512,
  seed_state: 1,
};
export const PROVENANCE = {
  kind: "explicit_synthetic_fixture_author",
  prior_model: null,
  prior_human_authentication: null,
  actual_purchase: null,
};
export type Identity = { database: string; parent: string; name: string };
export type Intent = { targets: Item[]; sourceContextSha256: string };
export type Header = {
  schemaVersion: number;
  instanceId: string;
  identity: Identity;
  fixtureBase64: string;
  fixtureSha256: string;
  provenance: typeof PROVENANCE;
  creation: "fixture";
  population: null;
};
export type Operation = {
  id: string;
  instanceId: string;
  tokenSha256: string;
  taskSha256: string;
  allowWrites: boolean;
  intent: Intent;
  initialFrontier: number;
  status: "active" | "closed";
  contentSha256: string;
};
export type Observation = {
  id: string;
  sequence: number;
  instanceId: string;
  operationId: string;
  purpose: "inspect";
  sku: string;
  frontier: number;
  contextSha256: string;
  value: ReturnType<typeof publicStock>;
  tokenSha256: string;
  contentSha256: string;
};
export type Decision = {
  id: string;
  sequence: number;
  instanceId: string;
  operationId: string | null;
  kind: Action["kind"];
  readId: string | null;
  args: Action["args"];
  status: "applied" | "unchanged" | "denied";
  result: Result;
  beforeContextSha256: string;
  afterContextSha256: string;
  contentSha256: string;
};
export type Context = {
  sourceSha256: string;
  frontier: number;
  businessSha256: string;
};
type Row = Record<string, string | number | null>;
export const digest = (value: unknown) => hash(canonical(value));
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export function uuid(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new Error("canonical managed UUID required");
}
export function hex(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new Error("original managed SHA256 or token required");
}
export function sealed<T extends object>(
  value: T,
): T & { contentSha256: string } {
  return { ...structuredClone(value), contentSha256: digest(value) };
}
export function checked(value: Record<string, unknown>) {
  hex(value.contentSha256);
  if (
    digest(
      Object.fromEntries(
        Object.entries(value).filter(([k]) => k !== "contentSha256"),
      ),
    ) !== value.contentSha256
  )
    throw new Error("original managed record hash differs");
}
export function jsonCell(raw: unknown): any {
  if (typeof raw !== "string")
    throw new Error("original managed JSON cell required");
  return parseJSON(Buffer.from(raw));
}
export function validateIntent(value: unknown): asserts value is Intent {
  keys(value, ["targets", "sourceContextSha256"]);
  hex(value.sourceContextSha256);
  if (
    !Array.isArray(value.targets) ||
    !value.targets.length ||
    value.targets.length > 128
  )
    throw new Error("exact bounded caller SKU targets required");
  value.targets.forEach(item);
  if (new Set(value.targets.map((r) => r.sku)).size !== value.targets.length)
    throw new Error("duplicate caller SKU target");
}
export function publicStock(data: Business, sku: string) {
  identifier(sku);
  const row = data.items.find((r) => r.sku === sku);
  if (!row) throw new Error("unknown inventory SKU");
  return {
    item: structuredClone(row),
    effective: effective(row),
    eligible: eligible(row),
    alerts: structuredClone(data.alerts.filter((r) => r.sku === sku)),
    drafts: structuredClone(data.drafts.filter((r) => r.sku === sku)),
  };
}
export const context = (
  doc: Header,
  frontier: number,
  business: Business,
): Context => ({
  sourceSha256: digest(
    Object.fromEntries(
      Object.entries(doc).filter(
        ([k]) => k !== "creation" && k !== "population",
      ),
    ),
  ),
  frontier,
  businessSha256: businessHash(business),
});
export function rows(
  db: DatabaseSync,
  table: keyof typeof TABLES,
  limit: number,
  order = "id",
): Row[] {
  const values = db
    .prepare(
      `SELECT *,hex(document) AS __document_hex FROM ${table} ORDER BY ${order} LIMIT ${limit + 1}`,
    )
    .all() as Row[];
  for (const row of values) {
    if (
      typeof row.document !== "string" ||
      Buffer.from(row.document).toString("hex").toUpperCase() !==
        row.__document_hex
    )
      throw new Error("original SQLite JSON text is not exact UTF8");
    delete row.__document_hex;
  }
  if (values.length > limit)
    throw new Error("complete managed table exceeds bound");
  return values;
}
export function schema(db: DatabaseSync) {
  const pragma = (name: string) =>
    Object.values(db.prepare("PRAGMA " + name).get() ?? {})[0];
  if (
    pragma("page_size") !== 4096 ||
    Number(pragma("page_count")) * 4096 > MAX_DATABASE_BYTES ||
    pragma("application_id") !== APPLICATION_ID ||
    pragma("user_version") !== SCHEMA_VERSION ||
    pragma("journal_mode") !== "delete" ||
    pragma("encoding") !== "UTF-8"
  )
    throw new Error("original managed SQLite header/size differs");
  const actual = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name",
    )
    .all();
  const expected: object[] = Object.entries(TABLES).map(([name, sql]) => ({
    type: "table",
    name,
    tbl_name: name,
    sql,
  }));
  for (const table of ["operations", "observations", "decisions"])
    for (const n of [1, 2])
      expected.push({
        type: "index",
        name: `sqlite_autoindex_${table}_${n}`,
        tbl_name: table,
        sql: null,
      });
  expected.sort((a: any, b: any) =>
    a.type < b.type
      ? -1
      : a.type > b.type
        ? 1
        : a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : 0,
  );
  if (
    !same(actual, expected) ||
    !same(db.prepare("PRAGMA quick_check").all(), [{ quick_check: "ok" }])
  )
    throw new Error("original exact managed schema/integrity differs");
  return actual;
}
export function header(
  db: DatabaseSync,
  identity: Identity,
  instanceId?: string,
) {
  const entries = rows(db, "metadata", 1);
  if (entries.length !== 1 || entries[0].id !== 1)
    throw new Error("one original inventory source required");
  const raw = entries[0].document as string,
    doc = jsonCell(raw) as Header;
  keys(doc, [
    "schemaVersion",
    "instanceId",
    "identity",
    "fixtureBase64",
    "fixtureSha256",
    "provenance",
    "creation",
    "population",
  ]);
  uuid(doc.instanceId);
  if (
    doc.schemaVersion !== SCHEMA_VERSION ||
    !same(doc.identity, identity) ||
    !same(doc.provenance, PROVENANCE) ||
    (instanceId !== undefined && instanceId !== doc.instanceId) ||
    doc.creation !== "fixture" ||
    doc.population !== null
  )
    throw new Error(
      "original managed inventory identity/provenance/source differs",
    );
  if (typeof doc.fixtureBase64 !== "string")
    throw new Error("original inventory fixture bytes required");
  const fixtureBytes = Buffer.from(doc.fixtureBase64, "base64");
  hex(doc.fixtureSha256);
  if (
    fixtureBytes.toString("base64") !== doc.fixtureBase64 ||
    hash(fixtureBytes) !== doc.fixtureSha256
  )
    throw new Error("original inventory fixture bytes/hash differ");
  const fixture = validateState(parseJSON(fixtureBytes));
  return { doc, fixture, raw };
}
export function operation(value: unknown): asserts value is Operation {
  keys(value, [
    "id",
    "instanceId",
    "tokenSha256",
    "taskSha256",
    "allowWrites",
    "intent",
    "initialFrontier",
    "status",
    "contentSha256",
  ]);
  uuid(value.id);
  uuid(value.instanceId);
  hex(value.tokenSha256);
  hex(value.taskSha256);
  validateIntent(value.intent);
  integer(value.initialFrontier);
  if (
    typeof value.allowWrites !== "boolean" ||
    !["active", "closed"].includes(value.status as string) ||
    Number(value.initialFrontier) > LIMITS.decisions
  )
    throw new Error("exact managed operation gate/status/frontier required");
  checked(value);
}
export function snapshot(
  db: DatabaseSync,
  identity: Identity,
  instanceId?: string,
) {
  const originalSchema = schema(db),
    { doc, fixture, raw } = header(db, identity, instanceId);
  const tables = {
    business: rows(db, "business", 1),
    operations: rows(db, "operations", LIMITS.operations, "rowid"),
    observations: rows(db, "observations", LIMITS.observations, "sequence"),
    decisions: rows(db, "decisions", LIMITS.decisions, "sequence"),
    seed_state: rows(db, "seed_state", 1),
  };
  if (
    tables.business.length !== 1 ||
    tables.business[0].id !== 1 ||
    tables.seed_state.length
  )
    throw new Error(
      "one current business source without unqualified seed authority required",
    );
  const current = jsonCell(tables.business[0].document) as Business;
  const operations = tables.operations.map((r) => {
    const v = jsonCell(r.document);
    operation(v);
    if (
      v.id !== r.id ||
      v.instanceId !== doc.instanceId ||
      v.tokenSha256 !== r.token_sha256
    )
      throw new Error("original operation row identity differs");
    return v;
  });
  if (operations.filter((o) => o.status === "active").length > 1)
    throw new Error("one cooperative model scope may be active");
  const opMap = new Map(operations.map((o) => [o.id, o]));
  const observations = tables.observations.map((r, n) => {
    const v = jsonCell(r.document) as Observation;
    keys(v, [
      "id",
      "sequence",
      "instanceId",
      "operationId",
      "purpose",
      "sku",
      "frontier",
      "contextSha256",
      "value",
      "tokenSha256",
      "contentSha256",
    ]);
    uuid(v.id);
    uuid(v.operationId);
    hex(v.contextSha256);
    hex(v.tokenSha256);
    identifier(v.sku);
    integer(v.frontier);
    checked(v);
    if (
      v.id !== r.id ||
      v.instanceId !== doc.instanceId ||
      v.sequence !== n + 1 ||
      r.sequence !== n + 1 ||
      v.operationId !== r.operation_id ||
      v.purpose !== "inspect" ||
      !opMap.has(v.operationId) ||
      v.frontier > tables.decisions.length
    )
      throw new Error("complete genuine scoped inventory observation required");
    return v;
  });
  const decisions = tables.decisions.map((r, n) => {
    const v = jsonCell(r.document) as Decision;
    keys(v, [
      "id",
      "sequence",
      "instanceId",
      "operationId",
      "kind",
      "readId",
      "args",
      "status",
      "result",
      "beforeContextSha256",
      "afterContextSha256",
      "contentSha256",
    ]);
    uuid(v.id);
    hex(v.beforeContextSha256);
    hex(v.afterContextSha256);
    checked(v);
    if (
      v.id !== r.id ||
      v.instanceId !== doc.instanceId ||
      v.sequence !== n + 1 ||
      r.sequence !== n + 1 ||
      v.operationId !== r.operation_id
    )
      throw new Error(
        "complete consecutive managed inventory decisions required",
      );
    return v;
  });
  const readMap = new Map(observations.map((r) => [r.id, r])),
    consumed = new Set<string>();
  let business = projection(fixture),
    currentContext = context(doc, 0, business);
  function frontier(n: number) {
    currentContext = context(doc, n, business);
    for (const op of operations.filter((o) => o.initialFrontier === n))
      if (
        op.intent.sourceContextSha256 !== digest(currentContext) ||
        op.intent.targets.some(
          (t) =>
            !same(
              business.items.find((r) => r.sku === t.sku),
              t,
            ),
        )
      )
        throw new Error(
          "original caller intent was not initial current source",
        );
    for (const read of observations.filter((r) => r.frontier === n)) {
      const op = opMap.get(read.operationId)!;
      if (
        n < op.initialFrontier ||
        !op.intent.targets.some((t) => t.sku === read.sku) ||
        read.contextSha256 !== digest(currentContext) ||
        !same(read.value, publicStock(business, read.sku))
      )
        throw new Error(
          "original scoped inventory read was never current source",
        );
    }
  }
  frontier(0);
  for (const [n, decision] of decisions.entries()) {
    if (decision.beforeContextSha256 !== digest(currentContext))
      throw new Error("original inventory decision before-context differs");
    const action = { kind: decision.kind, args: decision.args } as Action;
    if (action.kind === "event") {
      if (decision.operationId !== null || decision.readId !== null)
        throw new Error(
          "inventory events are a declared synthetic-human seam only",
        );
    } else if (action.kind === "evaluate" || action.kind === "prepare") {
      uuid(decision.operationId);
      uuid(decision.readId);
      const op = opMap.get(decision.operationId),
        read = readMap.get(decision.readId);
      if (
        !op ||
        !op.allowWrites ||
        !read ||
        read.operationId !== op.id ||
        read.sku !== action.args.sku ||
        read.frontier !== n ||
        read.contextSha256 !== digest(currentContext) ||
        consumed.has(read.id)
      )
        throw new Error(
          "current own unused exact inventory read/write scope required",
        );
      const target = op.intent.targets.find((t) => t.sku === action.args.sku),
        row = business.items.find((r) => r.sku === action.args.sku);
      if (!target || !row || target.name !== row.name)
        throw new Error("original caller SKU/name identity changed");
      consumed.add(read.id);
    } else throw new Error("unknown original managed inventory decision");
    const next = transition(business, action),
      status = !next.result.ok
        ? "denied"
        : same(business, next.business)
          ? "unchanged"
          : "applied";
    business = next.business;
    if (
      decision.status !== status ||
      !same(decision.result, next.result) ||
      decision.afterContextSha256 !== digest(context(doc, n + 1, business))
    )
      throw new Error(
        "original inventory decision contradicts complete transition replay",
      );
    frontier(n + 1);
  }
  if (
    operations.some((o) => o.initialFrontier > decisions.length) ||
    !same(current, business)
  )
    throw new Error(
      "current inventory differs from complete original decisions",
    );
  const original = { schema: originalSchema, sourceDocument: raw, tables };
  return {
    source: doc,
    fixture,
    original,
    sha256: digest(original),
    business,
    context: currentContext,
    contextSha256: digest(currentContext),
    records: { operations, observations, decisions },
  };
}
export type Snapshot = ReturnType<typeof snapshot>;
