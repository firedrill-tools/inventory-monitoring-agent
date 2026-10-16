import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManagedWorkspace } from "../src/managed.js";
import { canonical } from "../src/json.js";
import { digest, sealed } from "../src/managed-state.js";

const fixture = resolve(import.meta.dirname, "../../fixtures/starter.json");
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "inventory-managed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = ManagedWorkspace.seed(join(root, "state.db"), fixture);
  t.after(() => {
    if (!source.closeAttempted) source.close();
  });
  return { root, source };
}
const open = (s: ManagedWorkspace, writes = true, skus = ["SKU-101"]) =>
  s.registerOperation(
    digest("Evaluate and prepare selected synthetic inventory"),
    writes,
    s.inspectIntent(skus),
  );
const sale = (s: ManagedWorkspace) =>
  s.event({
    id: "EV-101",
    sku: "SKU-101",
    sequence: 101,
    kind: "sale",
    value: 4,
  });

test("own exact scoped observations produce actual atomic alert and replenishment decisions", (t) => {
  const { source: s } = setup(t);
  sale(s);
  const c = open(s),
    a = s.observe(c, "SKU-101");
  assert.equal(a.value.effective, 8);
  assert.equal(a.value.eligible, true);
  const evaluated = s.commit(c, a.proof, {
    kind: "evaluate",
    args: { sku: "SKU-101" },
  });
  assert.equal(evaluated.result.status, "alert_created");
  const b = s.observe(c, "SKU-101"),
    prepared = s.commit(c, b.proof, {
      kind: "prepare",
      args: { sku: "SKU-101", expectedRevision: 2 },
    });
  assert.equal(prepared.result.draft?.units, 16);
  assert.equal(prepared.decision.status, "applied");
  const final = s.observe(c, "SKU-101");
  assert.equal(final.value.drafts.length, 1);
  const current = s.snapshot();
  assert.equal(current.records.decisions.length, 3);
  assert.equal(current.business.alerts.length, 1);
  assert.equal(current.business.drafts.length, 1);
  assert.deepEqual(
    Buffer.from(current.source.fixtureBase64, "base64"),
    readFileSync(fixture),
  );
  const close = s.closeOperation(c);
  assert.equal(close.status, "closed");
  assert.deepEqual(s.closeOperation(c), close);
  assert.throws(
    () =>
      s.commit(c, final.proof, {
        kind: "prepare",
        args: { sku: "SKU-101", expectedRevision: 2 },
      }),
    /closed/,
  );
});

for (const fault of [
  "guessed_token",
  "borrowed_read",
  "stale_read",
  "consumed_read",
  "wrong_sku",
  "wrong_task_intent",
  "no_write",
  "model_event",
])
  test(
    "managed authority refuses " + fault + " without another business decision",
    (t) => {
      const { source: s } = setup(t);
      sale(s);
      const initial = s.inspectIntent(["SKU-101"]);
      if (fault === "wrong_task_intent") {
        initial.targets[0].quantity = 9;
        assert.throws(
          () => s.registerOperation(digest("task"), true, initial),
          /intent/,
        );
        assert.equal(s.snapshot().records.operations.length, 0);
        return;
      }
      const c = open(s, fault !== "no_write"),
        read = s.observe(c, "SKU-101");
      let proof = read.proof,
        scope = c;
      if (fault === "guessed_token") scope = { ...c, token: "0".repeat(64) };
      if (fault === "borrowed_read") {
        s.closeOperation(c);
        scope = open(s);
      }
      if (fault === "stale_read")
        s.event({
          id: "EV-102",
          sku: "SKU-101",
          sequence: 102,
          kind: "sale",
          value: 1,
        });
      if (fault === "consumed_read")
        s.commit(c, proof, { kind: "evaluate", args: { sku: "SKU-101" } });
      const before = s.snapshot();
      const action: any =
        fault === "model_event"
          ? {
              kind: "event",
              args: {
                id: "EV-MODEL",
                sku: "SKU-101",
                sequence: 200,
                kind: "receipt",
                value: 99,
              },
            }
          : {
              kind: "evaluate",
              args: { sku: fault === "wrong_sku" ? "SKU-102" : "SKU-101" },
            };
      assert.throws(() => s.commit(scope, proof, action));
      const after = s.snapshot();
      assert.deepEqual(after.business, before.business);
      assert.equal(
        after.records.decisions.length,
        before.records.decisions.length,
      );
      s.closeOperation(fault === "guessed_token" ? c : scope);
    },
  );

test("an actual customer event during scope invalidates old reads and fresh policy uses new threshold", (t) => {
  const { source: s } = setup(t);
  sale(s);
  const c = open(s),
    read = s.observe(c, "SKU-101");
  const other = new ManagedWorkspace(s.path);
  try {
    other.event({
      id: "EV-102",
      sku: "SKU-101",
      sequence: 102,
      kind: "threshold",
      value: 5,
    });
  } finally {
    other.close();
  }
  assert.throws(
    () =>
      s.commit(c, read.proof, { kind: "evaluate", args: { sku: "SKU-101" } }),
    /current own unused/,
  );
  const current = s.observe(c, "SKU-101");
  assert.equal(current.value.eligible, false);
  const result = s.commit(c, current.proof, {
    kind: "evaluate",
    args: { sku: "SKU-101" },
  });
  assert.equal(result.result.status, "above_threshold");
  assert.equal(result.decision.status, "unchanged");
  assert.equal(s.snapshot().business.alerts.length, 0);
  s.closeOperation(c);
});

test("one active scope, exact current intent and old private reads never authorize a later scope", (t) => {
  const { source: s } = setup(t);
  const intent = s.inspectIntent(["SKU-101"]),
    c = open(s),
    read = s.observe(c, "SKU-101");
  assert.throws(() => open(s), /active/);
  s.closeOperation(c);
  sale(s);
  assert.throws(
    () => s.registerOperation(digest("task"), true, intent),
    /intent/,
  );
  const next = open(s);
  assert.throws(
    () =>
      s.commit(next, read.proof, {
        kind: "evaluate",
        args: { sku: "SKU-101" },
      }),
    /current own unused/,
  );
  s.closeOperation(next);
});

test("duplicate events and repeated drafts retain literal business cell with honest unchanged decisions", (t) => {
  const { source: s } = setup(t);
  sale(s);
  const c = open(s);
  s.commit(c, s.observe(c, "SKU-101").proof, {
    kind: "evaluate",
    args: { sku: "SKU-101" },
  });
  s.commit(c, s.observe(c, "SKU-101").proof, {
    kind: "prepare",
    args: { sku: "SKU-101", expectedRevision: 2 },
  });
  const before = s.snapshot().original.tables.business[0].document;
  const repeat = s.commit(c, s.observe(c, "SKU-101").proof, {
    kind: "prepare",
    args: { sku: "SKU-101", expectedRevision: 2 },
  });
  assert.equal(repeat.decision.status, "unchanged");
  assert.equal(sale(s).result.error, "duplicate_event");
  assert.equal(s.snapshot().original.tables.business[0].document, before);
  s.closeOperation(c);
});

for (const fault of [
  "business",
  "read_rehashed",
  "decision_rehashed",
  "invalid_utf8",
  "schema",
])
  test("changed original SQL refuses without repairing " + fault, (t) => {
    const { source: s } = setup(t);
    sale(s);
    const c = open(s),
      read = s.observe(c, "SKU-101");
    s.commit(c, read.proof, { kind: "evaluate", args: { sku: "SKU-101" } });
    const before = s.snapshot(),
      db = new DatabaseSync(s.path);
    try {
      if (fault === "business") {
        const value = structuredClone(before.business);
        value.items[0].quantity = 9;
        db.prepare("UPDATE business SET document=?").run(canonical(value));
      }
      if (fault === "read_rehashed") {
        const value: any = structuredClone(before.records.observations[0]);
        value.value.item.quantity = 999;
        delete value.contentSha256;
        db.prepare("UPDATE observations SET document=? WHERE id=?").run(
          canonical(sealed(value)),
          read.proof.id,
        );
      }
      if (fault === "decision_rehashed") {
        const value: any = structuredClone(before.records.decisions[1]);
        value.result.status = "already_alerted";
        delete value.contentSha256;
        db.prepare("UPDATE decisions SET document=? WHERE id=?").run(
          canonical(sealed(value)),
          value.id,
        );
      }
      if (fault === "invalid_utf8")
        db.exec("UPDATE business SET document=CAST(X'FF' AS TEXT)");
      if (fault === "schema") db.exec("CREATE TABLE unrelated(value TEXT)");
    } finally {
      db.close();
    }
    const damaged = readFileSync(s.path);
    assert.throws(() => s.snapshot());
    assert.deepEqual(readFileSync(s.path), damaged);
    if (fault === "schema") assert.throws(() => s.closeOperation(c), /schema/);
    else assert.equal(s.closeOperation(c).status, "closed");
  });

test("cancelled business guard rolls back actual staged effects but durable scope close bypasses it", (t) => {
  const { source: s } = setup(t);
  sale(s);
  const c = open(s),
    read = s.observe(c, "SKU-101"),
    before = s.snapshot();
  s.commitGuard = () => {
    throw new Error("caller cancelled before commit");
  };
  assert.throws(
    () =>
      s.commit(c, read.proof, { kind: "evaluate", args: { sku: "SKU-101" } }),
    /cancelled/,
  );
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.closeOperation(c).status, "closed");
  assert.equal(s.snapshot().business.alerts.length, 0);
});

test("a real writer lock rejects registration truthfully without scope or business effect", (t) => {
  const { source: s } = setup(t),
    db = new DatabaseSync(s.path);
  const intent = s.inspectIntent(["SKU-101"]);
  db.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(
      () => s.registerOperation(digest("task"), true, intent),
      /locked|busy/,
    );
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
  assert.equal(s.snapshot().records.operations.length, 0);
  assert.equal(s.snapshot().records.decisions.length, 0);
});

test("copied SQL source cannot inherit physical identity and close owns both actual resources once", (t) => {
  const { source: s, root } = setup(t);
  const copied = join(root, "copied.db");
  copyFileSync(s.path, copied);
  assert.throws(() => new ManagedWorkspace(copied), /identity/);
  s.close();
  assert.equal(s.databaseCloseAttempted, true);
  assert.equal(s.databaseClosed, true);
  assert.equal(s.guardCloseAttempted, true);
  assert.equal(s.guardClosed, true);
  assert.equal(s.closed, true);
  assert.throws(() => s.snapshot(), /closed/);
  assert.throws(() => s.close(), /already attempted/);
});

test("actual Mastra tools require a genuine own inspection before each local write", async (t) => {
  const { makeManagedTools } = await import("../src/managed-tools.js");
  const { source: s } = setup(t);
  sale(s);
  const c = open(s),
    effects: unknown[] = [];
  const tools = makeManagedTools(s, c, { onDecision: (d) => effects.push(d) });
  assert.deepEqual(
    await tools.evaluateInventory.execute!({ sku: "SKU-101" }, {} as never),
    { ok: false, error: "current_read_required" },
  );
  const read: any = await tools.inspectInventory.execute!(
    { sku: "SKU-101" },
    {} as never,
  );
  assert.equal(read.items[0].effective, 8);
  for (const privateValue of [
    c.id,
    c.token,
    s.path,
    s.instanceId!,
    "tokenSha256",
    "sourceContextSha256",
    "fixtureBase64",
  ])
    assert.ok(!JSON.stringify(read).includes(privateValue));
  const evaluated: any = await tools.evaluateInventory.execute!(
    { sku: "SKU-101" },
    {} as never,
  );
  assert.equal(evaluated.status, "alert_created");
  assert.deepEqual(
    await tools.prepareReplenishment.execute!(
      { sku: "SKU-101", expectedRevision: 2 },
      {} as never,
    ),
    { ok: false, error: "current_read_required" },
  );
  await tools.inspectInventory.execute!({ sku: "SKU-101" }, {} as never);
  const draft: any = await tools.prepareReplenishment.execute!(
    { sku: "SKU-101", expectedRevision: 2 },
    {} as never,
  );
  assert.equal(draft.draft.units, 16);
  assert.equal(effects.length, 2);
  await assert.rejects(
    tools.inspectInventory.execute!({ sku: "SKU-102" }, {} as never),
    /outside caller/,
  );
  s.closeOperation(c);
});

test("actual Mastra readonly scope keeps write permission separate from inspection", async (t) => {
  const { makeManagedTools } = await import("../src/managed-tools.js");
  const { source: s } = setup(t);
  sale(s);
  const c = open(s, false),
    tools = makeManagedTools(s, c),
    before = s.snapshot().business;
  await tools.inspectInventory.execute!({ sku: "SKU-101" }, {} as never);
  assert.deepEqual(
    await tools.evaluateInventory.execute!({ sku: "SKU-101" }, {} as never),
    { ok: false, error: "writes_not_authorized" },
  );
  assert.deepEqual(
    await tools.prepareReplenishment.execute!(
      { sku: "SKU-101", expectedRevision: 2 },
      {} as never,
    ),
    { ok: false, error: "writes_not_authorized" },
  );
  assert.deepEqual(s.snapshot().business, before);
  assert.equal(s.snapshot().records.decisions.length, 1);
  s.closeOperation(c);
});

test("actual tool reinspection after an independent event derives current stock policy", async (t) => {
  const { makeManagedTools } = await import("../src/managed-tools.js");
  const { source: s } = setup(t);
  sale(s);
  const c = open(s),
    tools = makeManagedTools(s, c);
  await tools.inspectInventory.execute!({ sku: "SKU-101" }, {} as never);
  const other = new ManagedWorkspace(s.path);
  try {
    other.event({
      id: "EV-RECOVER",
      sku: "SKU-101",
      sequence: 102,
      kind: "stocktake",
      value: 20,
    });
  } finally {
    other.close();
  }
  await assert.rejects(
    tools.evaluateInventory.execute!({ sku: "SKU-101" }, {} as never),
    /current own unused/,
  );
  const current: any = await tools.inspectInventory.execute!(
    { sku: "SKU-101" },
    {} as never,
  );
  assert.equal(current.items[0].eligible, false);
  const result: any = await tools.evaluateInventory.execute!(
    { sku: "SKU-101" },
    {} as never,
  );
  assert.equal(result.status, "above_threshold");
  assert.equal(s.snapshot().business.alerts.length, 0);
  s.closeOperation(c);
});

test("actual tool factories cannot reuse a closed or another operation read", async (t) => {
  const { makeManagedTools } = await import("../src/managed-tools.js");
  const { source: s } = setup(t);
  sale(s);
  const c = open(s),
    old = makeManagedTools(s, c);
  await old.inspectInventory.execute!({ sku: "SKU-101" }, {} as never);
  s.closeOperation(c);
  const next = open(s),
    tools = makeManagedTools(s, next);
  await assert.rejects(
    old.evaluateInventory.execute!({ sku: "SKU-101" }, {} as never),
    /closed/,
  );
  assert.deepEqual(
    await tools.evaluateInventory.execute!({ sku: "SKU-101" }, {} as never),
    { ok: false, error: "current_read_required" },
  );
  assert.equal(s.snapshot().business.alerts.length, 0);
  s.closeOperation(next);
});

test("actual private CLI seeds, authors and inspects intent without importing runtime permissions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "inventory-private-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, "state.db"),
    entry = resolve(import.meta.dirname, "../src/managed-cli.js");
  const run = (args: string[], expected = 0) => {
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, expected, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const init = run(["init", "--db", db]);
  assert.equal(init.initialized, true);
  const event = run([
    "event",
    "--db",
    db,
    "--event-json",
    JSON.stringify({
      id: "EV-CLI",
      sku: "SKU-101",
      sequence: 101,
      kind: "sale",
      value: 4,
    }),
  ]);
  assert.equal(event.result.item.quantity, 8);
  const intent = run(["inspect", "--db", db, "--sku", "SKU-101"]);
  assert.equal(intent.targets.length, 1);
  assert.equal(intent.targets[0].revision, 2);
  const source = run(["inspect", "--db", db]);
  assert.equal(source.records.operations.length, 0);
  assert.equal(source.records.observations.length, 0);
  assert.equal(source.records.decisions.length, 1);
  const before = readFileSync(db);
  run(["init", "--db", db], 2);
  assert.deepEqual(readFileSync(db), before);
  const missing = join(root, "missing.db");
  run(["inspect", "--db", missing], 2);
  assert.equal(existsSync(missing), false);
});
