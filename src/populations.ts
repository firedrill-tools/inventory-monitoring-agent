/** Pinned synthetic histories and original private baseline validation. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  DATASET_BYTES,
  DATASET_CASES,
  DATASET_SHA256,
} from "./dataset-manifest.js";
import {
  canonical,
  hash,
  keys,
  MAX_BYTES,
  parseJSON,
  validText,
} from "./json.js";
import { type Action, type Business, identifier, integer } from "./domain.js";
import { projection, validateState, type InventoryState } from "./schema.js";
import type { Header } from "./managed-state.js";
export type PopulationReference = {
  id: string;
  version: string;
  caseId: string;
  datasetSha256: string;
  definitionSha256: string;
};
export type Definition = {
  id: string;
  profile: string;
  title: string;
  baseFixtureBase64: string;
  baseFixtureSha256: string;
  setup: Action[];
  fixtureBase64: string;
  fixtureSha256: string;
  skus: string[];
  duringNative: {
    request: number;
    action: Extract<Action, { kind: "event" }>;
    expected: { ok?: boolean; error?: string; throws?: string };
  }[];
  reference: Record<string, any>;
};
export type Population = {
  id: string;
  version: string;
  synthetic: boolean;
  provenance: Record<string, unknown>;
  cases: Definition[];
};
const digest = (v: unknown) => hash(canonical(v)),
  same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
let loaded: Population | undefined;
const validated = new Map<
  string,
  {
    definition: Definition;
    fixture: InventoryState;
    reference: PopulationReference;
  }
>();
function asset() {
  const path = resolve(import.meta.dirname, "../../fixtures/populations.json"),
    before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink < 1n ||
    before.size !== BigInt(DATASET_BYTES) ||
    before.size > BigInt(MAX_BYTES)
  )
    throw new Error("bounded regular pinned population asset required");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true }),
      raw = readFileSync(fd),
      after = fstatSync(fd, { bigint: true }),
      current = lstatSync(path, { bigint: true });
    const id = (s: typeof before) =>
      `${s.dev}:${s.ino}:${s.size}:${s.nlink}:${s.mtimeNs}:${s.ctimeNs}`;
    if (
      id(before) !== id(opened) ||
      id(opened) !== id(after) ||
      id(after) !== id(current) ||
      !current.isFile() ||
      raw.length !== DATASET_BYTES ||
      hash(raw) !== DATASET_SHA256
    )
      throw new Error(
        "original pinned inventory population bytes/identity/hash differ",
      );
    return raw;
  } finally {
    closeSync(fd);
  }
}
export function fixtureBytes(caseDefinition: Definition, prefix = "fixture") {
  const b64 = (caseDefinition as any)[prefix + "Base64"],
    sha = (caseDefinition as any)[prefix + "Sha256"];
  if (typeof b64 !== "string" || typeof sha !== "string")
    throw new Error("original population fixture bytes required");
  const raw = Buffer.from(b64, "base64");
  if (
    raw.length > MAX_BYTES ||
    raw.toString("base64") !== b64 ||
    hash(raw) !== sha
  )
    throw new Error("original population fixture bytes/hash differ");
  return raw;
}
function _dataset() {
  if (loaded) return loaded;
  const value = parseJSON(asset()) as unknown;
  keys(value, ["id", "version", "synthetic", "provenance", "cases"]);
  if (
    value.id !== "inventory-populations" ||
    value.version !== "1.0.0" ||
    value.synthetic !== true ||
    !Array.isArray(value.cases) ||
    value.cases.length !== DATASET_CASES
  )
    throw new Error("pinned inventory population identity differs");
  const provenance = {
    kind: "explicit_synthetic_human_source_author",
    prior_model: null,
    prior_human_authentication: null,
    actual_purchase: null,
  };
  if (!same(value.provenance, provenance))
    throw new Error("pinned synthetic population provenance differs");
  const entries = new Map<
    string,
    {
      definition: Definition;
      fixture: InventoryState;
      reference: PopulationReference;
    }
  >();
  const counts: Record<string, number> = {
    starter: 0,
    busy: 0,
    ambiguous: 0,
    boundary: 0,
  };
  for (const rawCase of value.cases) {
    keys(rawCase, [
      "id",
      "profile",
      "title",
      "baseFixtureBase64",
      "baseFixtureSha256",
      "setup",
      "fixtureBase64",
      "fixtureSha256",
      "skus",
      "duringNative",
      "reference",
    ]);
    const c = rawCase as unknown as Definition;
    if (
      typeof c.id !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(c.id) ||
      entries.has(c.id) ||
      !Object.hasOwn(counts, c.profile)
    )
      throw new Error("exact unique pinned case/profile required");
    counts[c.profile]++;
    validText(c.title, 1, 240);
    if (!Array.isArray(c.setup) || c.setup.length > 2048)
      throw new Error("complete bounded declared authoring steps required");
    const base = fixtureBytes(c, "baseFixture"),
      final = fixtureBytes(c),
      fixture = validateState(parseJSON(final));
    validateState(parseJSON(base));
    const history = fixture.history ?? [];
    if (
      history.length !== c.setup.length ||
      !same(
        history.map((h) => ({ kind: h.kind, args: h.args })),
        c.setup,
      ) ||
      (history.length
        ? fixture.origin!.fixture_base64 !== c.baseFixtureBase64
        : !base.equals(final))
    )
      throw new Error(
        "declared population setup differs from complete original human history",
      );
    if (
      !Array.isArray(c.skus) ||
      !c.skus.length ||
      c.skus.length > 128 ||
      new Set(c.skus).size !== c.skus.length
    )
      throw new Error("exact unique case targets required");
    for (const sku of c.skus) {
      identifier(sku);
      if (!fixture.items.some((r) => r.sku === sku))
        throw new Error("case target not in current fixture");
    }
    if (!Array.isArray(c.duringNative) || c.duringNative.length > 32)
      throw new Error("bounded private native events required");
    for (const effect of c.duringNative) {
      keys(effect, ["request", "action", "expected"]);
      integer(effect.request, 1);
      if (effect.request > 32 || effect.action?.kind !== "event")
        throw new Error("private event must name a bounded actual request");
    }
    for (const [name, expected] of Object.entries({
      items: fixture.items.length,
      events: fixture.events.length,
      alerts: fixture.alerts.length,
      drafts: fixture.drafts.length,
      currentDrafts: fixture.drafts.filter((d) => d.status === "current")
        .length,
      activeAlerts: fixture.alerts.filter((a) => a.status === "active").length,
      priorSteps: history.length,
    }))
      if (c.reference[name] !== expected)
        throw new Error("private population metrics contradict actual source");
    integer(c.reference.expectedNativeRequests, 1);
    if (
      c.reference.expectedNativeRequests > 32 ||
      !["completed", "needs_replan"].includes(c.reference.expectedStatus)
    )
      throw new Error("bounded private reference outcome required");
    const reference = {
      id: "inventory-populations",
      version: "1.0.0",
      caseId: c.id,
      datasetSha256: DATASET_SHA256,
      definitionSha256: digest(c),
    };
    entries.set(c.id, { definition: c, fixture, reference });
  }
  if (Object.values(counts).some((n) => n !== 3))
    throw new Error("three cases per pinned profile required");
  loaded = value as unknown as Population;
  for (const [id, entry] of entries) validated.set(id, entry);
  return loaded;
}
function internal(caseId: unknown) {
  _dataset();
  if (typeof caseId !== "string" || !validated.has(caseId))
    throw new Error("unknown pinned inventory case");
  return validated.get(caseId)!;
}
export const dataset = () => structuredClone(_dataset());
export const definition = (caseId: string) =>
  structuredClone(internal(caseId).definition);
export const reference = (caseDefinition: Definition) =>
  structuredClone(internal(caseDefinition.id).reference);
export function populationFixture(doc: Header) {
  keys(doc.population, [
    "id",
    "version",
    "caseId",
    "datasetSha256",
    "definitionSha256",
  ]);
  const entry = internal(doc.population.caseId);
  if (
    !same(doc.population, entry.reference) ||
    doc.fixtureBase64 !== entry.definition.fixtureBase64 ||
    doc.fixtureSha256 !== entry.definition.fixtureSha256
  )
    throw new Error("original pinned population reference/fixture differs");
  return structuredClone(entry.fixture);
}
export function validatePopulationSeed(
  doc: Header,
  tables: Record<string, Record<string, any>[]>,
  schema: unknown,
) {
  const entry = internal(doc.population?.caseId);
  populationFixture(doc);
  if (tables.seed_state.length !== 1 || tables.seed_state[0].id !== 1)
    throw new Error("one original pinned population seed required");
  const seed = parseJSON(Buffer.from(tables.seed_state[0].document));
  keys(seed, [
    "schemaVersion",
    "instanceId",
    "reference",
    "original",
    "originalSha256",
    "contextSha256",
    "provenance",
    "contentSha256",
  ]);
  if (
    seed.contentSha256 !==
      digest(
        Object.fromEntries(
          Object.entries(seed).filter(([k]) => k !== "contentSha256"),
        ),
      ) ||
    seed.schemaVersion !== 1 ||
    seed.instanceId !== doc.instanceId ||
    !same(seed.reference, entry.reference) ||
    !same(seed.provenance, _dataset().provenance)
  )
    throw new Error(
      "original population seed identity/provenance/hash differs",
    );
  keys(seed.original, ["schema", "sourceDocument", "tables"]);
  const original = seed.original;
  if (
    digest(original) !== seed.originalSha256 ||
    !same(original.schema, schema) ||
    original.sourceDocument !==
      canonical({ ...doc, creation: "fixture", population: null })
  )
    throw new Error(
      "original population initialization schema/header/hash differs",
    );
  keys(original.tables, Object.keys(tables));
  const prior = original.tables;
  if (
    ["operations", "observations", "decisions", "seed_state"].some(
      (t) => !same(prior[t], []),
    )
  )
    throw new Error("population seed cannot import runtime authority");
  const business = projection(entry.fixture),
    ctx = {
      sourceSha256: digest(
        Object.fromEntries(
          Object.entries(doc).filter(
            ([k]) => k !== "creation" && k !== "population",
          ),
        ),
      ),
      frontier: 0,
      businessSha256: digest(business),
    };
  if (
    !same(prior.business, [{ id: 1, document: canonical(business) }]) ||
    seed.contextSha256 !== digest(ctx)
  )
    throw new Error("original population baseline business/context differs");
  return seed;
}
