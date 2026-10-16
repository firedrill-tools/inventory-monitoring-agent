import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Workspace, loadState } from "../src/workspace.js";
import { canonical, hash } from "../src/json.js";

const fixture = resolve(import.meta.dirname, "../../fixtures/starter.json");
const original = readFileSync(fixture);
function setup(t: TestContext, edit?: (data: any) => void) {
  const root = mkdtempSync(join(tmpdir(), "inventory-source-")),
    file = join(root, "state.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (edit) {
    const data = JSON.parse(original.toString());
    edit(data);
    writeFileSync(file, JSON.stringify(data));
  } else copyFileSync(fixture, file);
  const workspace = new Workspace(file);
  t.after(() => workspace.close());
  return { root, file, workspace };
}
const low = (w: Workspace) => {
  w.applyEvent({
    id: "EV-101",
    sku: "SKU-101",
    sequence: 101,
    kind: "sale",
    value: 4,
  });
  w.evaluate("SKU-101");
  return w.prepare("SKU-101", 2);
};

for (const [label, edit] of Object.entries({
  bool_quantity: (d: any) => {
    d.items[0].quantity = true;
  },
  bool_revision: (d: any) => {
    d.items[0].revision = true;
  },
  unsafe_effective: (d: any) => {
    d.items[0].quantity = Number.MAX_SAFE_INTEGER;
    d.items[0].onOrder = 1;
  },
  negative_quantity: (d: any) => {
    d.items[0].quantity = -1;
  },
  fractional_quantity: (d: any) => {
    d.items[0].quantity = 1.5;
  },
  duplicate_sku: (d: any) => {
    d.items.push({ ...d.items[0] });
  },
  noncanonical_sku: (d: any) => {
    d.items[0].sku = "../../other";
  },
  oversized_name: (d: any) => {
    d.items[0].name = "x".repeat(201);
  },
  unknown_field: (d: any) => {
    d.items[0].authorized = true;
  },
  impossible_target: (d: any) => {
    d.items[0].target = 1;
  },
  unsupported_alert: (d: any) => {
    d.items[0].alertActive = true;
  },
  prior_unproven_draft: (d: any) => {
    d.drafts.push({
      id: "DR-1",
      sku: "SKU-101",
      revision: 1,
      units: 999,
      status: "current",
    });
  },
}))
  test(
    "invalid complete inventory refuses without changing bytes: " + label,
    (t) => {
      const root = mkdtempSync(join(tmpdir(), "inventory-invalid-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const file = join(root, "state.json"),
        data = JSON.parse(original.toString());
      edit(data);
      const bytes = Buffer.from(JSON.stringify(data));
      writeFileSync(file, bytes);
      assert.throws(() => new Workspace(file));
      assert.deepEqual(readFileSync(file), bytes);
    },
  );

for (const [label, raw] of Object.entries({
  duplicate: original
    .toString()
    .replace('"quantity": 12', '"quantity": 12, "quantity": 0'),
  nonfinite: original.toString().replace('"quantity": 12', '"quantity": 1e999'),
  negative_zero: original
    .toString()
    .replace('"quantity": 12', '"quantity": -0'),
  lone_surrogate: original.toString().replace("Elm desk lamp", "\\ud800"),
  deep: "[".repeat(66) + "0" + "]".repeat(66),
  invalid_utf8: Buffer.concat([
    original.subarray(0, 20),
    Buffer.from([0xff]),
    original.subarray(20),
  ]),
  trailing: original.toString() + " {}",
}))
  test("original JSON ambiguity refuses: " + label, (t) => {
    const root = mkdtempSync(join(tmpdir(), "inventory-json-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, "state.json");
    writeFileSync(file, raw);
    assert.throws(() => loadState(file));
    assert.deepEqual(readFileSync(file), Buffer.from(raw));
  });

test("recovery and reentry between evaluations creates a new cycle from real events", (t) => {
  const { file, workspace: w } = setup(t);
  low(w);
  w.applyEvent({
    id: "EV-102",
    sku: "SKU-101",
    sequence: 102,
    kind: "stocktake",
    value: 20,
  });
  assert.equal(w.inspect("SKU-101").items[0].alertActive, false);
  w.applyEvent({
    id: "EV-103",
    sku: "SKU-101",
    sequence: 103,
    kind: "stocktake",
    value: 8,
  });
  const evaluation = w.evaluate("SKU-101");
  assert.equal(evaluation.status, "alert_created");
  assert.equal(evaluation.alertId, "ALT-2");
  const state = loadState(file);
  assert.deepEqual(
    state.alerts.map((a) => [a.id, a.status, a.closedBy]),
    [
      ["ALT-1", "closed", "EV-102"],
      ["ALT-2", "active", null],
    ],
  );
  assert.equal(state.drafts[0].status, "superseded");
  assert.equal(w.prepare("SKU-101", 4).draft?.alertId, "ALT-2");
  assert.equal(state.origin?.provenance.prior_model, null);
  assert.equal(state.origin?.provenance.actual_purchase, null);
  assert.deepEqual(
    Buffer.from(state.origin!.fixture_base64, "base64"),
    original,
  );
});

test("receipt retains separate recorded on-order quantity and guards safe effective arithmetic", (t) => {
  const { file, workspace: w } = setup(t);
  const result = w.applyEvent({
    id: "EV-R1",
    sku: "SKU-102",
    sequence: 51,
    kind: "receipt",
    value: 4,
  });
  assert.equal(result.item?.quantity, 7);
  assert.equal(result.item?.onOrder, 4);
  assert.equal(w.inspect("SKU-102").items[0].effective, 11);
  const bytes = readFileSync(file);
  assert.throws(
    () =>
      w.applyEvent({
        id: "EV-R2",
        sku: "SKU-102",
        sequence: 52,
        kind: "receipt",
        value: Number.MAX_SAFE_INTEGER,
      }),
    /safe/,
  );
  assert.deepEqual(readFileSync(file), bytes);
});

for (const field of ["quantity", "revision"] as const)
  test("maximum " + field + " cannot overflow before source effect", (t) => {
    const { file, workspace: w } = setup(t, (d) => {
      d.items[0][field] = Number.MAX_SAFE_INTEGER;
    });
    const before = readFileSync(file);
    assert.throws(
      () =>
        w.applyEvent({
          id: "EV-MAX",
          sku: "SKU-101",
          sequence: 101,
          kind: "receipt",
          value: 1,
        }),
      /safe|exhausted/,
    );
    assert.deepEqual(readFileSync(file), before);
  });

test("last safe stock and revision changes reach maximum exactly", (t) => {
  const { workspace: w } = setup(t, (d) => {
    d.items[0].quantity = Number.MAX_SAFE_INTEGER - 1;
    d.items[0].revision = Number.MAX_SAFE_INTEGER - 1;
  });
  const result = w.applyEvent({
    id: "EV-LAST",
    sku: "SKU-101",
    sequence: 101,
    kind: "receipt",
    value: 1,
  });
  assert.equal(result.item?.quantity, Number.MAX_SAFE_INTEGER);
  assert.equal(result.item?.revision, Number.MAX_SAFE_INTEGER);
});

for (const mutation of [
  "draft",
  "event",
  "missing_history",
  "rehashed_result",
  "read",
  "origin",
  "foreign_sku",
])
  test("full history refuses changed source: " + mutation, (t) => {
    const { file, workspace: w } = setup(t);
    low(w);
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (mutation === "draft") state.drafts[0].units = 999999;
    if (mutation === "event") state.events[0].value = 3;
    if (mutation === "missing_history") state.history.splice(0, 1);
    if (mutation === "rehashed_result") {
      state.history[0].result.item.quantity = 999;
      state.history[0].after_sha256 = hash(
        canonical({
          items: state.items,
          events: state.events,
          alerts: state.alerts,
          drafts: state.drafts,
        }),
      );
    }
    if (mutation === "read") state.history[0].read.name = "borrowed";
    if (mutation === "origin") state.origin.fixture_sha256 = "0".repeat(64);
    if (mutation === "foreign_sku") state.drafts[0].source.sku = "SKU-102";
    const raw = Buffer.from(JSON.stringify(state));
    writeFileSync(file, raw);
    assert.throws(() => w.prepare("SKU-101", 2), /history|fixture/);
    assert.deepEqual(readFileSync(file), raw);
  });

for (const alias of ["symlink", "hardlink"])
  test("source " + alias + " refuses before accepting outside bytes", (t) => {
    const root = mkdtempSync(join(tmpdir(), "inventory-alias-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const other = join(root, "other.json"),
      file = join(root, "source.json");
    writeFileSync(other, original);
    if (alias === "symlink") symlinkSync(other, file);
    else linkSync(other, file);
    assert.throws(() => new Workspace(file), /regular/);
    assert.deepEqual(readFileSync(other), original);
  });

test("source owner rejects replacement even when copied bytes and does not overwrite another writer", (t) => {
  const { file, workspace: w, root } = setup(t);
  const other = new Workspace(file);
  t.after(() => other.close());
  w.applyEvent({
    id: "EV-1",
    sku: "SKU-101",
    sequence: 101,
    kind: "sale",
    value: 4,
  });
  const current = readFileSync(file);
  assert.throws(() => other.evaluate("SKU-101"), /identity/);
  assert.deepEqual(readFileSync(file), current);
  const copy = join(root, "copy.json");
  copyFileSync(file, copy);
  renameSync(copy, file);
  assert.throws(() => w.read(), /identity/);
  assert.deepEqual(readFileSync(file), current);
});

test("unchanged evaluations, duplicate events and current drafts preserve literal source bytes", (t) => {
  const { file, workspace: w, root } = setup(t);
  const initial = readFileSync(file);
  w.evaluate("SKU-101");
  assert.deepEqual(readFileSync(file), initial);
  low(w);
  const before = readFileSync(file);
  const repeated = w.prepare("SKU-101", 2);
  assert.equal(repeated.draft?.units, 16);
  w.evaluate("SKU-101");
  assert.equal(
    w.applyEvent({
      id: "EV-101",
      sku: "SKU-101",
      sequence: 101,
      kind: "sale",
      value: 4,
    }).error,
    "duplicate_event",
  );
  assert.deepEqual(readFileSync(file), before);
  const canary = join(root, `state.json.${process.pid}.tmp`);
  writeFileSync(canary, "owned canary");
  w.applyEvent({
    id: "EV-NEXT",
    sku: "SKU-101",
    sequence: 102,
    kind: "sale",
    value: 1,
  });
  assert.equal(readFileSync(canary, "utf8"), "owned canary");
});
