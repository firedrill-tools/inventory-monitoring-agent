/** Private model-free pinned cases; reset preserves the old source and evidence. */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { ManagedWorkspace } from "./managed.js";
import * as state from "./managed-state.js";
import { canonical, hash, keys, parseJSON } from "./json.js";
import { readOriginal, readRegular } from "./workspace.js";
import { dataset, definition, fixtureBytes, reference } from "./populations.js";

const physical = (s: { dev: bigint; ino: bigint }) => `${s.dev}:${s.ino}`;
const inside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return !r || (!r.startsWith(".." + sep) && r !== ".." && !isAbsolute(r));
};
function rootPath(path: string) {
  const supplied = resolve(path);
  if (
    !lstatSync(supplied).isDirectory() ||
    lstatSync(supplied).isSymbolicLink()
  )
    throw new Error("original regular nonsymlink case root required");
  return realpathSync(supplied);
}
function exclusive(path: string, bytes: Buffer) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(dirname(path), constants.O_RDONLY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
function locked<T>(root: string, action: () => T) {
  const path = resolve(root, ".case-control.lock"),
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    ),
    created = fstatSync(fd, { bigint: true });
  try {
    writeFileSync(fd, randomUUID());
    fsyncSync(fd);
    return action();
  } finally {
    closeSync(fd);
    const current = lstatSync(path, { bigint: true });
    if (physical(current) !== physical(created))
      throw new Error("original private control mutex identity changed");
    unlinkSync(path);
  }
}
function publishSeed(
  source: ManagedWorkspace,
  before: state.Snapshot,
  ref: ReturnType<typeof reference>,
  seed: object,
) {
  source.assertCurrentIdentity();
  const db = new DatabaseSync(source.path);
  try {
    db.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250; BEGIN IMMEDIATE",
    );
    const current = state.snapshot(db, source.identity, source.instanceId);
    if (current.sha256 !== before.sha256)
      throw new Error("original source changed during private initialization");
    const doc = { ...before.source, creation: "population", population: ref };
    db.prepare("UPDATE metadata SET document=? WHERE id=1").run(canonical(doc));
    db.prepare("INSERT INTO seed_state VALUES (1,?)").run(canonical(seed));
    state.snapshot(db, source.identity, source.instanceId);
    source.assertCurrentIdentity();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}
export function initialize(
  root: string,
  caseId: string,
  options: {
    generation?: number;
    resetOf?: { root: string; instanceId: string; sourceSha256: string };
  } = {},
) {
  const c = definition(caseId),
    supplied = resolve(root);
  mkdirSync(dirname(supplied), { recursive: true, mode: 0o700 });
  root = resolve(realpathSync(dirname(supplied)), basename(supplied));
  mkdirSync(root, { mode: 0o700 });
  const fixture = resolve(root, "fixture.json");
  exclusive(fixture, fixtureBytes(c));
  const source = ManagedWorkspace.seed(resolve(root, "inventory.db"), fixture);
  let seed: any, ref: ReturnType<typeof reference>;
  try {
    const before = source.snapshot();
    ref = reference(c);
    seed = state.sealed({
      schemaVersion: 1,
      instanceId: source.instanceId,
      reference: ref,
      original: before.original,
      originalSha256: before.sha256,
      contextSha256: before.contextSha256,
      provenance: dataset().provenance,
    });
    publishSeed(source, before, ref, seed);
  } finally {
    source.close();
  }
  const qualified = new ManagedWorkspace(resolve(root, "inventory.db"));
  let control: object;
  try {
    control = state.sealed({
      schemaVersion: 1,
      kind: "private_synthetic_inventory_case",
      root,
      rootIdentity: physical(lstatSync(root, { bigint: true })),
      database: "inventory.db",
      instanceId: qualified.instanceId,
      reference: ref!,
      seedSha256: seed.contentSha256,
      sourceDocumentSha256: hash(qualified.snapshot().original.sourceDocument),
      generation: options.generation ?? 1,
      resetOf: options.resetOf ?? null,
    });
  } finally {
    qualified.close();
  }
  exclusive(
    resolve(root, "control.json"),
    Buffer.from(JSON.stringify(control, null, 2) + "\n"),
  );
  return inspectUnlocked(root);
}
function inspectUnlocked(root: string) {
  const control = parseJSON(readRegular(resolve(root, "control.json")).raw);
  keys(control, [
    "schemaVersion",
    "kind",
    "root",
    "rootIdentity",
    "database",
    "instanceId",
    "reference",
    "seedSha256",
    "sourceDocumentSha256",
    "generation",
    "resetOf",
    "contentSha256",
  ]);
  state.checked(control);
  if (
    control.schemaVersion !== 1 ||
    control.kind !== "private_synthetic_inventory_case" ||
    control.root !== root ||
    control.rootIdentity !== physical(lstatSync(root, { bigint: true })) ||
    control.database !== "inventory.db" ||
    typeof control.generation !== "number" ||
    !Number.isSafeInteger(control.generation) ||
    control.generation < 1 ||
    control.generation > 2 ** 31 - 1
  )
    throw new Error(
      "original private case control identity/generation differs",
    );
  state.uuid(control.instanceId);
  state.hex(control.seedSha256);
  state.hex(control.sourceDocumentSha256);
  if (control.resetOf !== null) {
    keys(control.resetOf, ["root", "instanceId", "sourceSha256"]);
    if (
      typeof control.resetOf.root !== "string" ||
      !isAbsolute(control.resetOf.root)
    )
      throw new Error("original reset predecessor root required");
    state.uuid(control.resetOf.instanceId);
    state.hex(control.resetOf.sourceSha256);
  } else if (control.generation !== 1)
    throw new Error("reset generation has no predecessor");
  const source = new ManagedWorkspace(resolve(root, "inventory.db"));
  try {
    const current = source.snapshot();
    if (
      current.source.creation !== "population" ||
      current.original.tables.seed_state.length !== 1
    )
      throw new Error("original private case source/seed markers missing");
    const seed = state.jsonCell(current.original.tables.seed_state[0].document);
    keys(control.reference, [
      "id",
      "version",
      "caseId",
      "datasetSha256",
      "definitionSha256",
    ]);
    const c = definition(control.reference.caseId as string),
      ref = reference(c);
    if (
      control.instanceId !== source.instanceId ||
      !state.same(control.reference, ref) ||
      !state.same(current.source.population, ref) ||
      control.seedSha256 !== seed.contentSha256 ||
      control.sourceDocumentSha256 !== hash(current.original.sourceDocument) ||
      !readOriginal(resolve(root, "fixture.json")).raw.equals(fixtureBytes(c))
    )
      throw new Error("original private case control/source/fixture differs");
    return {
      root,
      database: source.path,
      instanceId: source.instanceId,
      caseId: c.id,
      profile: c.profile,
      title: c.title,
      generation: control.generation,
      resetOf: control.resetOf,
      intent: source.inspectIntent(c.skus),
      skus: c.skus,
      privateDuringNative: c.duringNative,
      privateReference: c.reference,
      population: ref,
      seedSha256: seed.contentSha256,
      sourceSha256: current.sha256,
      metrics: {
        items: current.business.items.length,
        events: current.business.events.length,
        alerts: current.business.alerts.length,
        drafts: current.business.drafts.length,
      },
      source: current,
      provenance: {
        priorModel: null,
        priorHumanAuthentication: null,
        actualPurchase: null,
      },
      authority:
        "private model-free inspection; no runtime read/write capability",
    };
  } finally {
    source.close();
  }
}
export function inspectCase(root: string) {
  root = rootPath(root);
  return locked(root, () => inspectUnlocked(root));
}
function destination(path: string) {
  const supplied = resolve(path),
    parts: string[] = [];
  let parent = dirname(supplied);
  for (;;) {
    try {
      lstatSync(parent);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      parts.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
  return resolve(realpathSync(parent), ...parts, basename(supplied));
}
export function resetCase(root: string, newRoot: string) {
  root = rootPath(root);
  const candidate = destination(newRoot);
  if (inside(candidate, root) || inside(root, candidate))
    throw new Error(
      "reset requires a separate new root; preserve original source and evidence",
    );
  return locked(root, () => {
    const previous = inspectUnlocked(root);
    if (previous.generation === 2 ** 31 - 1)
      throw new Error("case reset generation exhausted");
    return initialize(candidate, previous.caseId, {
      generation: previous.generation + 1,
      resetOf: {
        root,
        instanceId: previous.instanceId!,
        sourceSha256: previous.sourceSha256,
      },
    });
  });
}
export function main(argv = process.argv.slice(2)) {
  const command = argv[0],
    options = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i],
      value = argv[i + 1];
    if (
      !["--root", "--new-root", "--case"].includes(key) ||
      !value ||
      value.startsWith("--") ||
      options.has(key)
    )
      throw new Error("exact private case arguments required");
    options.set(key, value);
  }
  const required = (name: string) => {
    const value = options.get(name);
    if (value === undefined) throw new Error(name + " required");
    return value;
  };
  let result: unknown;
  if (command === "list" && options.size === 0) {
    const d = dataset();
    result = {
      id: d.id,
      version: d.version,
      cases: d.cases.map((c) => ({
        id: c.id,
        profile: c.profile,
        title: c.title,
      })),
    };
  } else if (command === "init" && options.size === 2)
    result = initialize(required("--root"), required("--case"));
  else if (command === "inspect" && options.size === 1)
    result = inspectCase(required("--root"));
  else if (command === "reset" && options.size === 2)
    result = resetCase(required("--root"), required("--new-root"));
  else
    throw new Error(
      "Usage: inventory-cases list|init --case ID --root NEW|inspect --root ROOT|reset --root ROOT --new-root NEW",
    );
  console.log(JSON.stringify(result, null, 2));
}
