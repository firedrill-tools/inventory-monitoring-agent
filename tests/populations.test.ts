/** Actual private commands, coherent prior worlds and real normal SDK cases. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dataset, definition, fixtureBytes } from "../src/populations.js";
import { initialize, inspectCase, resetCase } from "../src/cases.js";
import { ManagedWorkspace } from "../src/managed.js";
import { canonical } from "../src/json.js";
import { digest, sealed } from "../src/managed-state.js";
import { runMonitor } from "../src/runtime.js";
const CASES = dataset().cases.map((c) => c.id),
  KEY = "synthetic-population-inventory-key",
  MODEL = "google/gemini-2.5-flash";
function directory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "inventory-cases-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function cli(...args: string[]) {
  const r = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, "../src/cases-cli.js"), ...args],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60000 },
  );
  assert.equal(r.status, 0, r.stdout.slice(-8000) + r.stderr);
  return JSON.parse(r.stdout);
}
const files = (root: string) =>
  Object.fromEntries(
    readdirSync(root)
      .filter((n) => lstatSync(join(root, n)).isFile())
      .map((n) => [n, readFileSync(join(root, n))]),
  );

for (const id of CASES)
  test(
    "actual private CLI init/inspect retains full original history and empty runtime authority: " +
      id,
    (t) => {
      const root = directory(t),
        c = definition(id),
        info = cli("init", "--case", id, "--root", join(root, "case")),
        inspected = cli("inspect", "--root", info.root);
      assert.deepEqual(info, inspected);
      assert.deepEqual(
        readFileSync(join(info.root, "fixture.json")),
        fixtureBytes(c),
      );
      assert.equal(info.metrics.items, c.reference.items);
      assert.equal(info.metrics.events, c.reference.events);
      assert.equal(info.metrics.alerts, c.reference.alerts);
      assert.equal(info.metrics.drafts, c.reference.drafts);
      assert.equal(
        info.source.fixture.history?.length ?? 0,
        c.reference.priorSteps,
      );
      assert.ok(
        ["operations", "observations", "decisions"].every(
          (k) => info.source.records[k].length === 0,
        ),
      );
      assert.equal(info.source.original.tables.seed_state.length, 1);
      assert.equal(info.source.source.creation, "population");
      assert.deepEqual(info.skus, c.skus);
      assert.equal(info.intent.sourceContextSha256, info.source.contextSha256);
      assert.equal(lstatSync(info.root).mode & 0o777, 0o700);
      for (const name of ["control.json", "fixture.json", "inventory.db"])
        assert.equal(lstatSync(join(info.root, name)).mode & 0o777, 0o600);
    },
  );

for (const id of CASES)
  test(
    "actual private preserving reset creates new UUID/seed and keeps every old file: " +
      id,
    (t) => {
      const root = directory(t),
        info = initialize(join(root, "case"), id);
      writeFileSync(
        join(info.root, "kept-evidence.json"),
        JSON.stringify({
          kind: "explicit test evidence",
          source: info.sourceSha256,
        }),
      );
      const before = files(info.root);
      const reset = cli(
        "reset",
        "--root",
        info.root,
        "--new-root",
        join(root, "new-parent", "fresh"),
      );
      assert.deepEqual(files(info.root), before);
      assert.equal(reset.generation, 2);
      assert.notEqual(reset.instanceId, info.instanceId);
      assert.notEqual(reset.seedSha256, info.seedSha256);
      assert.deepEqual(reset.source.business, info.source.business);
      assert.equal(reset.resetOf.instanceId, info.instanceId);
      assert.equal(reset.resetOf.sourceSha256, info.sourceSha256);
      assert.ok(
        ["operations", "observations", "decisions"].every(
          (k) => reset.source.records[k].length === 0,
        ),
      );
    },
  );

/** Chooses actions only from actual public tool results, with no reference oracle. */
function nextAction(body: any) {
  const responses = body.contents
      .flatMap((m: any) => m.parts)
      .filter((p: any) => p.functionResponse)
      .map((p: any) => p.functionResponse),
    last = responses.at(-1);
  if (
    !last ||
    last.name !== "inspectInventory" ||
    !Array.isArray(last.response?.content?.items)
  )
    return { functionCall: { name: "inspectInventory", args: {} } };
  const data = last.response.content;
  for (const item of data.items) {
    if (!item.eligible) continue;
    const row = { ...item };
    delete row.effective;
    delete row.eligible;
    const current = data.drafts.some(
      (d: any) =>
        d.sku === item.sku &&
        d.status === "current" &&
        d.revision === item.revision &&
        d.units === item.target - item.effective &&
        canonical(d.source) === canonical(row),
    );
    if (current) continue;
    if (!item.alertActive)
      return {
        functionCall: { name: "evaluateInventory", args: { sku: item.sku } },
      };
    return {
      functionCall: {
        name: "prepareReplenishment",
        args: { sku: item.sku, expectedRevision: item.revision },
      },
    };
  }
  return {
    text: "Current selected inventory was inspected. Local drafts are prepared only for current eligible items; no purchase was placed.",
  };
}
for (const id of CASES)
  test(
    "normal actual Mastra Google SDK exercises private world and resets after actual effects: " +
      id,
    async (t) => {
      const root = directory(t),
        c = definition(id),
        info = initialize(join(root, "case"), id),
        source = new ManagedWorkspace(info.database);
      t.after(() => source.close());
      const requests: any[] = [],
        errors: unknown[] = [],
        events: any[] = [];
      const server = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString()),
            n = requests.length + 1;
          requests.push(body);
          assert.equal(
            req.url,
            "/v1beta/models/gemini-2.5-flash:generateContent",
          );
          assert.equal(req.headers["x-goog-api-key"], KEY);
          for (const change of c.duringNative.filter((e) => e.request === n)) {
            let result: any, error: any;
            try {
              result = source.event(change.action.args);
            } catch (caught) {
              error = caught;
            }
            if (change.expected.throws) {
              assert.ok(error instanceof Error);
              assert.ok(error.message.includes(change.expected.throws));
              events.push({ status: "rejected", message: error.message });
            } else {
              assert.equal(error, undefined);
              assert.equal(result.result.ok, change.expected.ok);
              if (change.expected.error)
                assert.equal(result.result.error, change.expected.error);
              events.push(result);
            }
          }
          const value = {
            candidates: [
              {
                index: 0,
                content: { role: "model", parts: [nextAction(body)] },
                finishReason: "STOP",
              },
            ],
            responseId: "population-owned-" + n,
            modelVersion: "gemini-2.5-flash-synthetic",
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 2,
              totalTokenCount: 12,
            },
            original_unknown: { preserved: true },
          };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        } catch (error) {
          errors.push(error);
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      t.after(() => new Promise<void>((done) => server.close(() => done())));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const before = source.snapshot().business,
        result = await runMonitor({
          database: info.database,
          task: "Evaluate current selected inventory, prepare needed local drafts and inspect the current result.",
          skus: info.skus,
          intent: info.intent,
          model: MODEL,
          apiKey: KEY,
          baseURL: `http://127.0.0.1:${address.port}/v1beta`,
          allowWrites: true,
          outputRoot: join(info.root, "receipts"),
        });
      assert.equal(result.status, c.reference.expectedStatus);
      assert.equal(
        result.business.workflowComplete,
        c.reference.expectedStatus === "completed",
      );
      assert.equal(result.cleanupConfirmed, true);
      assert.equal(requests.length, c.reference.expectedNativeRequests);
      assert.equal(events.length, c.duringNative.length);
      assert.equal(errors.length, 0);
      const current = source.snapshot(),
        selected = new Set(c.skus);
      assert.deepEqual(
        current.business.items.filter((r) => !selected.has(r.sku)),
        before.items.filter((r) => !selected.has(r.sku)),
      );
      assert.equal(current.records.operations[0].status, "closed");
      assert.deepEqual(
        current.business.alerts
          .slice(0, before.alerts.length)
          .map((a) => a.source),
        before.alerts.map((a) => a.source),
      );
      assert.deepEqual(
        current.business.drafts
          .slice(0, before.drafts.length)
          .map((d) => d.source),
        before.drafts.map((d) => d.source),
      );
      const wire = JSON.stringify(requests);
      for (const privateValue of [
        id,
        info.instanceId!,
        info.seedSha256,
        info.root,
        "definitionSha256",
        "fixtureBase64",
        "privateReference",
      ])
        assert.ok(!wire.includes(privateValue));
      const receipt = readFileSync(result.receiptPath),
        old = files(info.root),
        after = inspectCase(info.root),
        fresh = resetCase(info.root, join(root, "reset-after-effect"));
      assert.deepEqual(files(info.root), old);
      assert.deepEqual(readFileSync(result.receiptPath), receipt);
      assert.equal(fresh.resetOf!.instanceId, info.instanceId);
      assert.equal(fresh.resetOf!.sourceSha256, after.sourceSha256);
      assert.notEqual(fresh.instanceId, info.instanceId);
      assert.deepEqual(fresh.source.business, before);
      assert.equal(fresh.source.records.operations.length, 0);
    },
  );

for (const mutation of [
  "seed_missing",
  "pointer_missing",
  "rehashed_seed",
  "foreign_reference",
  "rehashed_control",
  "copied",
  "locked",
  "fixture_alias",
])
  test(
    "private case refuses damaged, foreign or occupied control without repair: " +
      mutation,
    (t) => {
      const root = directory(t),
        info = initialize(join(root, "case"), "starter_low");
      let target = info.root;
      if (
        [
          "seed_missing",
          "pointer_missing",
          "rehashed_seed",
          "foreign_reference",
        ].includes(mutation)
      ) {
        const db = new DatabaseSync(info.database);
        try {
          if (mutation === "seed_missing") db.exec("DELETE FROM seed_state");
          else if (mutation === "pointer_missing") {
            const doc = JSON.parse(
              db.prepare("SELECT document FROM metadata").get()!
                .document as string,
            );
            doc.creation = "fixture";
            doc.population = null;
            db.prepare("UPDATE metadata SET document=?").run(canonical(doc));
          } else if (mutation === "foreign_reference") {
            const doc = JSON.parse(
              db.prepare("SELECT document FROM metadata").get()!
                .document as string,
            );
            doc.population.caseId = "starter_on_order";
            db.prepare("UPDATE metadata SET document=?").run(canonical(doc));
          } else {
            const doc = JSON.parse(
              db.prepare("SELECT document FROM seed_state").get()!
                .document as string,
            );
            doc.original.tables.business[0].document = "{}";
            doc.originalSha256 = digest(doc.original);
            delete doc.contentSha256;
            db.prepare("UPDATE seed_state SET document=?").run(
              canonical(sealed(doc)),
            );
          }
        } finally {
          db.close();
        }
      } else if (mutation === "rehashed_control") {
        const doc = JSON.parse(
          readFileSync(join(target, "control.json"), "utf8"),
        );
        doc.instanceId = "00000000-0000-0000-0000-000000000000";
        delete doc.contentSha256;
        writeFileSync(join(target, "control.json"), canonical(sealed(doc)));
      } else if (mutation === "copied") {
        target = join(root, "copied");
        cpSync(info.root, target, { recursive: true });
      } else if (mutation === "locked")
        writeFileSync(
          join(target, ".case-control.lock"),
          "another actual attempt",
        );
      else {
        renameSync(join(target, "fixture.json"), join(target, "original.json"));
        symlinkSync(
          join(target, "original.json"),
          join(target, "fixture.json"),
        );
      }
      const before = files(target);
      assert.throws(() => inspectCase(target));
      assert.throws(() => resetCase(target, join(root, "rejected")));
      assert.deepEqual(files(target), before);
    },
  );

test("case collisions and nested reset requests preserve original source files", (t) => {
  const root = directory(t),
    info = initialize(join(root, "case"), "starter_repeat"),
    before = files(info.root);
  for (const candidate of [
    info.root,
    join(info.root, "missing-parent", "child"),
    root,
  ])
    assert.throws(() => resetCase(info.root, candidate));
  assert.throws(() => initialize(info.root, "starter_low"));
  assert.deepEqual(files(info.root), before);
});
