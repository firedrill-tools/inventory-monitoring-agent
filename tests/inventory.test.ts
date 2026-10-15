import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Workspace, loadState } from "../src/workspace.js";
import { makeTools } from "../src/agent.js";

function setup() { const file = join(mkdtempSync(join(tmpdir(), "inventory-")), "workspace.json");
  copyFileSync(resolve(import.meta.dirname, "../../fixtures/starter.json"), file); return { file, workspace: new Workspace(file) }; }

test("repeated and stale events never double-apply stock", () => {
  const { file, workspace } = setup();
  const event = { id: "EV-101", sku: "SKU-101", sequence: 101, kind: "sale" as const, value: 4 };
  assert.equal(workspace.applyEvent(event).ok, true);
  assert.deepEqual(workspace.applyEvent(event), { ok: false, error: "duplicate_event" });
  assert.equal(workspace.applyEvent({ ...event, value: 3 }).error, "event_id_reused");
  assert.equal(workspace.applyEvent({ ...event, id: "EV-102", sequence: 100 }).error, "stale_sequence");
  assert.equal(workspace.applyEvent({ ...event, id: "EV-103", sequence: 102, value: 99 }).error, "insufficient_stock");
  assert.equal(loadState(file).items[0].quantity, 8);
  assert.equal(loadState(file).events.length, 1);
});

test("one alert per low-stock cycle; drafts recheck revisions and counts", () => {
  const { file, workspace } = setup();
  workspace.applyEvent({ id: "EV-101", sku: "SKU-101", sequence: 101, kind: "sale", value: 4 });
  const first = workspace.evaluate("SKU-101");
  assert.equal(first.status, "alert_created"); assert.equal(first.units, 16);
  assert.equal(workspace.evaluate("SKU-101").status, "already_alerted");
  const draft = workspace.prepare("SKU-101", 2);
  assert.equal(draft.draft?.units, 16);
  assert.equal(workspace.prepare("SKU-101", 2).draft?.id, draft.draft?.id);
  workspace.applyEvent({ id: "EV-102", sku: "SKU-101", sequence: 102, kind: "sale", value: 2 });
  assert.equal(workspace.evaluate("SKU-101").status, "already_alerted");
  assert.equal(workspace.prepare("SKU-101", 2).error, "stale_revision");
  assert.equal(workspace.prepare("SKU-101", 3).draft?.units, 18);
  assert.equal(loadState(file).drafts[0].status, "superseded");
  assert.equal(loadState(file).alerts.length, 1);
});

test("on-order stock and threshold changes determine alert eligibility", () => {
  const { file, workspace } = setup();
  assert.equal(workspace.evaluate("SKU-102").status, "above_threshold");
  workspace.applyEvent({ id: "EV-201", sku: "SKU-102", sequence: 51, kind: "threshold", value: 8 });
  assert.equal(workspace.evaluate("SKU-102").status, "alert_created");
  assert.equal(workspace.prepare("SKU-102", 2).draft?.units, 5);
  workspace.applyEvent({ id: "EV-202", sku: "SKU-102", sequence: 52, kind: "threshold", value: 5 });
  assert.equal(workspace.evaluate("SKU-102").status, "above_threshold");
  assert.equal(loadState(file).drafts[0].status, "superseded");
  assert.equal(workspace.prepare("SKU-102", 3).error, "not_below_threshold");
  workspace.applyEvent({ id: "EV-203", sku: "SKU-102", sequence: 53, kind: "threshold", value: 8 });
  assert.equal(workspace.evaluate("SKU-102").status, "alert_created");
  assert.equal(loadState(file).alerts.length, 2);
});

test("Mastra tools expose a real read-only boundary", async () => {
  const { workspace } = setup(); const tools = makeTools(workspace, false);
  const inspected = await tools.inspectInventory.execute!({ sku: "SKU-101" }, {} as never) as ReturnType<Workspace["inspect"]>;
  assert.equal(inspected.items.length, 1);
  assert.deepEqual(await tools.evaluateInventory.execute!({ sku: "SKU-101" }, {} as never), { ok: false, error: "writes_not_authorized" });
  assert.deepEqual(await tools.prepareReplenishment.execute!({ sku: "SKU-101", expectedRevision: 1 }, {} as never), { ok: false, error: "writes_not_authorized" });
});
