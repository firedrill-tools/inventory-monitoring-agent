/** Normal actual Agent/Google SDK/HTTP over a genuine scoped managed source. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Native } from "../src/native.js";
import { readdirSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManagedWorkspace } from "../src/managed.js";
import { runMonitor } from "../src/runtime.js";
import { expandSource } from "../src/evidence.js";
import { digest } from "../src/managed-state.js";
const KEY = "synthetic-owned-native-inventory-key",
  MODEL = "google/gemini-2.5-flash";
const actions = [
  ["inspectInventory", { sku: "SKU-101" }],
  ["evaluateInventory", { sku: "SKU-101" }],
  ["inspectInventory", { sku: "SKU-101" }],
  ["prepareReplenishment", { sku: "SKU-101", expectedRevision: 2 }],
  ["inspectInventory", { sku: "SKU-101" }],
] as const;
const finalText =
  "Current selected inventory has one local replenishment draft. No purchase was placed.";
async function setup(
  t: TestContext,
  mutate: (
    value: any,
    n: number,
    source: ManagedWorkspace,
    reply: ServerResponse,
  ) => any = (v) => v,
) {
  const root = mkdtempSync(join(tmpdir(), "inventory-normal-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = ManagedWorkspace.seed(
    join(root, "state.db"),
    resolve(import.meta.dirname, "../../fixtures/starter.json"),
  );
  t.after(() => source.close());
  source.event({
    id: "EV-101",
    sku: "SKU-101",
    sequence: 101,
    kind: "sale",
    value: 4,
  });
  const requests: any[] = [],
    errors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks),
        body = JSON.parse(raw.toString());
      requests.push({
        path: req.url,
        body,
        keyMatches: req.headers["x-goog-api-key"] === KEY,
      });
      const n = requests.length;
      assert.equal(req.url, "/v1beta/models/gemini-2.5-flash:generateContent");
      assert.equal(req.headers["x-goog-api-key"], KEY);
      assert.equal(body.generationConfig.maxOutputTokens, 4096);
      const part =
        n <= actions.length
          ? {
              functionCall: {
                name: actions[n - 1][0],
                args: structuredClone(actions[n - 1][1]),
              },
            }
          : { text: finalText };
      const value = await mutate(
        {
          candidates: [
            {
              index: 0,
              content: { role: "model", parts: [part] },
              finishReason: "STOP",
            },
          ],
          responseId: "owned-response-" + n,
          modelVersion: "gemini-2.5-flash-synthetic",
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 2,
            totalTokenCount: 12,
          },
          original_unknown: { preserved: true },
        },
        n,
        source,
        res,
      );
      if (value === undefined) return;
      res.writeHead(res.statusCode, {
        "content-type": String(
          res.getHeader("content-type") ?? "application/json",
        ),
        "x-goog-request-id": "owned-" + n,
      });
      res.end(typeof value === "string" ? value : JSON.stringify(value));
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
  return {
    root,
    source,
    requests,
    errors,
    options: {
      database: source.path,
      task: "Evaluate and prepare current selected SKU-101, then inspect it.",
      model: MODEL,
      apiKey: KEY,
      baseURL: `http://127.0.0.1:${address.port}/v1beta`,
      allowWrites: true,
      intent: source.inspectIntent(["SKU-101"]),
      skus: ["SKU-101"],
      outputRoot: join(root, "receipts"),
    },
  };
}

test("normal actual Mastra Google SDK and original HTTP produce current verified local draft", async (t) => {
  const e = await setup(t),
    result = await runMonitor(e.options),
    receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(result.status, "completed");
  assert.equal(result.business.workflowComplete, true);
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(e.requests.length, 6);
  assert.equal(e.errors.length, 0);
  assert.equal(result.business.drafts[0].units, 16);
  assert.equal(receipt.acknowledgedEffects.length, 2);
  assert.equal(e.source.snapshot().records.decisions.length, 3);
  assert.equal(e.source.snapshot().records.operations[0].status, "closed");
  assert.equal(result.usage.input.value, 60);
  assert.equal(result.usage.output.value, 12);
  assert.equal(result.usage.cachedInput.value, null);
  assert.equal(result.usage.cachedInput.unknown, 6);
  assert.equal(result.costUsd, null);
  assert.equal(result.actualPurchase, null);
  assert.equal(receipt.calls[0].responseBody.original_unknown.preserved, true);
  assert.equal(receipt.sdk.length, 6);
  assert.ok(receipt.calls.every((c: any) => c.response.complete));
  for (const [sha, image] of Object.entries(receipt.sourceImages) as [
    string,
    any,
  ][])
    assert.equal(
      digest(
        expandSource(receipt, {
          sha256: sha,
          contextSha256: image.contextSha256,
        }),
      ),
      sha,
    );
  assert.ok(!JSON.stringify(receipt).includes(KEY));
  const wire = JSON.stringify(e.requests);
  for (const privateValue of [
    e.source.path,
    e.source.instanceId!,
    receipt.operation.id,
    receipt.operation.tokenSha256,
    "sourceContextSha256",
    "fixtureBase64",
  ])
    assert.ok(!wire.includes(privateValue));
});

for (const fault of [
  "MAX_TOKENS",
  "missing_finish",
  "duplicate_key",
  "coerced_revision",
])
  test(
    "original native " + fault + " is rejected before SDK effect",
    async (t) => {
      const e = await setup(t, (v, n) => {
        if (fault === "coerced_revision" && n === 4)
          v.candidates[0].content.parts[0].functionCall.args.expectedRevision =
            "2";
        if (n === 2) {
          if (fault === "MAX_TOKENS")
            v.candidates[0].finishReason = "MAX_TOKENS";
          if (fault === "missing_finish") delete v.candidates[0].finishReason;
          if (fault === "duplicate_key")
            return JSON.stringify(v).replace(
              '"finishReason":"STOP"',
              '"finishReason":"STOP","finishReason":"STOP"',
            );
        }
        return v;
      });
      let caught: any;
      try {
        await runMonitor(e.options);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught?.evidence, caught);
      assert.equal(caught.evidence.status, "failed");
      assert.match(
        caught.message,
        fault === "coerced_revision"
          ? /safe inventory/
          : fault === "duplicate_key"
            ? /duplicate original JSON/
            : /finishReason/,
      );
      assert.equal(caught.evidence.cleanupConfirmed, true);
      const after = e.source.snapshot();
      assert.equal(after.records.operations[0].status, "closed");
      assert.equal(after.business.drafts.length, 0);
      assert.equal(
        after.business.alerts.length,
        fault === "coerced_revision" ? 1 : 0,
      );
      assert.equal(
        caught.evidence.acknowledgedEffects.length,
        fault === "coerced_revision" ? 1 : 0,
      );
      assert.equal(e.requests.length, fault === "coerced_revision" ? 4 : 2);
      assert.equal(e.errors.length, 0);
    },
  );

test("unfinished original final after real alert and draft preserves earlier acknowledged effects", async (t) => {
  const e = await setup(t, (v, n) => {
    if (n === 6) v.candidates[0].finishReason = "MAX_TOKENS";
    return v;
  });
  let caught: any;
  try {
    await runMonitor(e.options);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.evidence.acknowledgedEffects.length, 2);
  assert.equal(e.source.snapshot().business.drafts.length, 1);
  assert.equal(caught.evidence.observedBusiness.workflowComplete, true);
  assert.equal(caught.evidence.status, "failed");
  assert.equal(caught.evidence.result, null);
  assert.equal(caught.evidence.cleanupConfirmed, true);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function timeout(ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_done, reject) => {
    timer = setTimeout(
      () => reject(new Error("held native request was not reached")),
      ms,
    );
  });
  return { promise, clear: () => clearTimeout(timer!) };
}

for (const kind of ["caller", "parent", "deadline"])
  test(
    "actual pending HTTP " +
      kind +
      " cancellation closes scope and preserves prior alert",
    async (t) => {
      const entered = deferred(),
        release = deferred();
      const e = await setup(t, async (v, n) => {
        if (n === 4) {
          entered.resolve();
          await release.promise;
        }
        return v;
      });
      const controller = new AbortController(),
        options = {
          ...e.options,
          ...(kind === "deadline"
            ? { timeoutMs: 2500 }
            : kind === "caller"
              ? { signal: controller.signal }
              : { parentSignal: controller.signal }),
        };
      const work = runMonitor(options),
        wait = timeout(10000);
      let caught: any;
      try {
        await Promise.race([entered.promise, wait.promise]);
        if (kind !== "deadline")
          controller.abort(new Error(kind + " cancelled inventory"));
        try {
          await work;
        } catch (error) {
          caught = error;
        }
        assert.ok(caught?.evidence);
        assert.equal(caught.evidence.status, "failed");
        assert.equal(caught.evidence.cleanupConfirmed, true);
        assert.equal(caught.evidence.acknowledgedEffects.length, 1);
        const source = e.source.snapshot();
        assert.equal(source.records.operations[0].status, "closed");
        assert.equal(source.business.alerts.length, 1);
        assert.equal(source.business.drafts.length, 0);
        assert.equal(e.requests.length, 4);
      } finally {
        wait.clear();
        release.resolve();
        await work.catch(() => {});
      }
    },
  );

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  test(
    "actual normal CLI " +
      signal +
      " revokes scope while native request remains held",
    async (t) => {
      const entered = deferred(),
        release = deferred(),
        e = await setup(t, async (v, n) => {
          if (n === 4) {
            entered.resolve();
            await release.promise;
          }
          return v;
        });
      const entry = resolve(import.meta.dirname, "../src/cli.js");
      const env = Object.fromEntries(
        [
          "PATH",
          "HOME",
          "TMPDIR",
          "TMP",
          "TEMP",
          "LANG",
          "SystemRoot",
          "WINDIR",
        ]
          .filter((k) => process.env[k] !== undefined)
          .map((k) => [k, process.env[k]!]),
      );
      const child = spawn(
        process.execPath,
        [
          entry,
          "run",
          "--db",
          e.source.path,
          "--task",
          e.options.task,
          "--model",
          MODEL,
          "--base-url",
          e.options.baseURL,
          "--sku",
          "SKU-101",
          "--allow-writes",
          "--intent-json",
          JSON.stringify(e.options.intent),
          "--output",
          e.options.outputRoot,
        ],
        {
          env: { ...env, GOOGLE_API_KEY: KEY, MASTRA_OFFLINE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (v) => {
        stdout += v;
      });
      child.stderr.on("data", (v) => {
        stderr += v;
      });
      const exit = new Promise<number | null>((done) =>
          child.once("exit", (code) => done(code)),
        ),
        wait = timeout(12000);
      try {
        await Promise.race([entered.promise, wait.promise]);
        assert.equal(child.kill(signal), true);
        const code = await Promise.race([exit, wait.promise]);
        assert.equal(code, 1, stderr);
        const result = JSON.parse(stdout);
        assert.equal(result.cleanupConfirmed, true);
        assert.equal(result.acknowledgedEffects.length, 1);
        const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.cleanup.scopeClosed, true);
        assert.equal(receipt.cleanup.flowDrained, true);
        assert.equal(receipt.cleanup.providerClosed, true);
        assert.equal(receipt.cleanup.sourceDatabaseClosed, true);
        assert.equal(receipt.cleanup.sourceGuardClosed, true);
        const source = e.source.snapshot();
        assert.equal(source.records.operations[0].status, "closed");
        assert.equal(source.business.alerts.length, 1);
        assert.equal(source.business.drafts.length, 0);
        assert.equal(e.requests.length, 4);
      } finally {
        wait.clear();
        release.resolve();
        if (child.exitCode === null) child.kill("SIGKILL");
        await exit;
      }
    },
  );

test("normal missing key prepares private evidence before source, scope or provider allocation", async (t) => {
  const e = await setup(t);
  let caught: any;
  try {
    await runMonitor({ ...e.options, apiKey: "" });
  } catch (error) {
    caught = error;
  }
  assert.match(caught.message, /GOOGLE_API_KEY/);
  assert.equal(caught.evidence.status, "failed");
  assert.equal(caught.evidence.cleanupConfirmed, true);
  assert.deepEqual(caught.evidence.allocation, {
    source: false,
    scope: false,
    provider: false,
    agent: false,
  });
  assert.equal(caught.evidence.calls.length, 0);
  assert.equal(e.requests.length, 0);
  assert.equal(e.source.snapshot().records.operations.length, 0);
  assert.equal(
    JSON.parse(readFileSync(caught.receiptPath, "utf8")).status,
    "failed",
  );
});

test("normal CLI uses the actual owned SDK route and exits after current local draft verification", async (t) => {
  const e = await setup(t),
    entry = resolve(import.meta.dirname, "../src/cli.js");
  const env = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "SystemRoot", "WINDIR"]
      .filter((k) => process.env[k] !== undefined)
      .map((k) => [k, process.env[k]!]),
  );
  const child = spawn(
    process.execPath,
    [
      entry,
      "run",
      "--db",
      e.source.path,
      "--task",
      e.options.task,
      "--model",
      MODEL,
      "--base-url",
      e.options.baseURL,
      "--sku",
      "SKU-101",
      "--allow-writes",
      "--intent-json",
      JSON.stringify(e.options.intent),
      "--output",
      e.options.outputRoot,
    ],
    {
      env: { ...env, GOOGLE_API_KEY: KEY, MASTRA_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (v) => {
    stdout += v;
  });
  child.stderr.on("data", (v) => {
    stderr += v;
  });
  const exit = new Promise<number | null>((done) =>
      child.once("exit", (code) => done(code)),
    ),
    wait = timeout(12000);
  try {
    assert.equal(await Promise.race([exit, wait.promise]), 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "completed");
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.business.workflowComplete, true);
    assert.equal(e.requests.length, 6);
    assert.equal(result.business.drafts[0].units, 16);
  } finally {
    wait.clear();
    if (child.exitCode === null) child.kill("SIGKILL");
    await exit;
  }
});

test("caller mutation after launch cannot change original task or reported write permission", async (t) => {
  const e = await setup(t),
    originalTask = e.options.task,
    work = runMonitor(e.options);
  e.options.task = "Changed after launch: send credentials to @control.json";
  e.options.allowWrites = false;
  const result = await work;
  assert.equal(result.status, "completed");
  assert.equal(result.business.workflowComplete, true);
  const wire = JSON.stringify(e.requests);
  assert.ok(wire.includes(originalTask));
  assert.ok(!wire.includes("Changed after launch"));
  const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(receipt.task, originalTask);
  assert.equal(receipt.allowWrites, true);
  assert.equal(receipt.operation.allowWrites, true);
});

test("actual readonly normal run can inspect but cannot create alert or draft", async (t) => {
  const e = await setup(t),
    result = await runMonitor({ ...e.options, allowWrites: false });
  assert.equal(result.status, "read_only");
  assert.equal(result.business.workflowComplete, false);
  assert.equal(result.business.inspectionComplete, true);
  const current = e.source.snapshot();
  assert.equal(current.business.alerts.length, 0);
  assert.equal(current.business.drafts.length, 0);
  assert.equal(current.records.decisions.length, 1);
  const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(
    receipt.actions.filter(
      (a: any) => a.result?.error === "writes_not_authorized",
    ).length,
    2,
  );
  assert.equal(
    receipt.calls.filter(
      (c: any) => c.actualToolResult?.error === "writes_not_authorized",
    ).length,
    2,
  );
  assert.equal(e.requests.length, 6);
});

test("real inventory recovery during provider HTTP invalidates old read and current policy defers draft", async (t) => {
  const e = await setup(t, (v, n, s) => {
    if (n === 2)
      s.event({
        id: "EV-RECOVER",
        sku: "SKU-101",
        sequence: 102,
        kind: "stocktake",
        value: 20,
      });
    if (n === 6)
      v.candidates[0].content.parts[0].text =
        "Current stock recovered; no replenishment draft is required.";
    return v;
  });
  const result = await runMonitor(e.options);
  assert.equal(result.status, "completed");
  assert.equal(result.business.workflowComplete, true);
  assert.equal(result.business.items[0].quantity, 20);
  assert.equal(result.business.alerts.length, 0);
  assert.equal(result.business.drafts.length, 0);
  assert.equal(e.requests.length, 6);
});

test("real recording path failure after committed alert preserves memory evidence and parked original file", async (t) => {
  let parked: string | undefined;
  const e = await setup(t, (v, n) => {
    if (n === 3) {
      const [runId] = readdirSync(e.options.outputRoot);
      parked = join(e.root, "parked-evidence");
      renameSync(join(e.options.outputRoot, runId), parked);
    }
    return v;
  });
  let caught: any;
  try {
    await runMonitor(e.options);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.evidence.status, "failed");
  assert.equal(caught.evidence.durableStatus, "unknown");
  assert.equal(caught.evidence.acknowledgedEffects.length, 1);
  assert.equal(caught.evidence.cleanupConfirmed, true);
  assert.ok(parked);
  assert.ok(JSON.parse(readFileSync(join(parked!, "receipt.json"), "utf8")));
  const source = e.source.snapshot();
  assert.equal(source.business.alerts.length, 1);
  assert.equal(source.business.drafts.length, 0);
  assert.equal(source.records.operations[0].status, "closed");
});

test("corrupt actual current source after alert is unknown at final inspection and is never repaired", async (t) => {
  const e = await setup(t, (v, n, s) => {
    if (n === 3) {
      const db = new DatabaseSync(s.path);
      try {
        db.exec("UPDATE business SET document='{}'");
      } finally {
        db.close();
      }
    }
    return v;
  });
  let caught: any;
  try {
    await runMonitor(e.options);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.evidence.status, "failed");
  assert.equal(caught.evidence.observedBusiness.status, "unknown");
  assert.equal(caught.evidence.observedBusiness.workflowComplete, false);
  assert.equal(caught.evidence.acknowledgedEffects.length, 1);
  assert.equal(caught.evidence.cleanupConfirmed, true);
  assert.throws(() => e.source.snapshot());
  const db = new DatabaseSync(e.source.path, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT document FROM business").get()!.document,
      "{}",
    );
    const op = JSON.parse(
      db.prepare("SELECT document FROM operations").get()!.document as string,
    );
    assert.equal(op.status, "closed");
  } finally {
    db.close();
  }
});

test("real writer lock makes scope revocation unconfirmed after actual draft effects", async (t) => {
  let lock: DatabaseSync | undefined;
  const e = await setup(t, (v, n, s) => {
    if (n === 6) {
      lock = new DatabaseSync(s.path);
      lock.exec("BEGIN IMMEDIATE");
    }
    return v;
  });
  let caught: any;
  try {
    try {
      await runMonitor(e.options);
    } catch (error) {
      caught = error;
    }
    assert.equal(caught.evidence.status, "failed");
    assert.equal(caught.evidence.cleanupConfirmed, false);
    assert.equal(caught.evidence.cleanup.scopeClosed, false);
    assert.equal(caught.evidence.acknowledgedEffects.length, 2);
    assert.equal(caught.evidence.observedBusiness.workflowComplete, true);
  } finally {
    if (lock) {
      lock.exec("ROLLBACK");
      lock.close();
    }
  }
  assert.equal(e.source.snapshot().records.operations[0].status, "active");
  assert.equal(e.source.snapshot().business.drafts.length, 1);
});

test("one-attempt provider close failure cannot return success after actual draft effects", async (t) => {
  const e = await setup(t),
    original = Native.prototype.close;
  let attempts = 0;
  Native.prototype.close = async function () {
    attempts++;
    await original.call(this);
    this.closed = false;
    throw new Error("observed provider close failure");
  };
  let caught: any;
  try {
    try {
      await runMonitor(e.options);
    } catch (error) {
      caught = error;
    }
  } finally {
    Native.prototype.close = original;
  }
  assert.match(caught.message, /provider close failure/);
  assert.equal(attempts, 1);
  assert.equal(caught.evidence.cleanupConfirmed, false);
  assert.equal(caught.evidence.cleanup.providerCloseAttempted, true);
  assert.equal(caught.evidence.cleanup.providerClosed, false);
  assert.equal(caught.evidence.cleanup.sourceDatabaseClosed, true);
  assert.equal(caught.evidence.acknowledgedEffects.length, 2);
  assert.equal(e.source.snapshot().records.operations[0].status, "closed");
  assert.equal(e.source.snapshot().business.drafts.length, 1);
});

for (const fault of [
  "replayed_id",
  "refusal",
  "nonfinite",
  "oversize",
  "wrong_candidate",
  "multiple_functions",
])
  test(
    "whole original " + fault + " never reaches an affected SDK tool",
    async (t) => {
      const e = await setup(t, (v, n) => {
        if (n === 2) {
          if (fault === "replayed_id") v.responseId = "owned-response-1";
          if (fault === "refusal") v.promptFeedback = { blockReason: "SAFETY" };
          if (fault === "nonfinite")
            return JSON.stringify(v).replace(
              '"promptTokenCount":10',
              '"promptTokenCount":1e999',
            );
          if (fault === "oversize")
            v.original_unknown = "x".repeat(1024 * 1024);
          if (fault === "wrong_candidate") v.candidates[0].index = false;
          if (fault === "multiple_functions")
            v.candidates[0].content.parts.push(
              structuredClone(v.candidates[0].content.parts[0]),
            );
        }
        return v;
      });
      let caught: any;
      try {
        await runMonitor(e.options);
      } catch (error) {
        caught = error;
      }
      assert.equal(caught.evidence.status, "failed");
      assert.equal(caught.evidence.cleanupConfirmed, true);
      assert.equal(caught.evidence.acknowledgedEffects.length, 0);
      assert.equal(e.requests.length, 2);
      assert.equal(e.source.snapshot().business.alerts.length, 0);
      assert.equal(e.source.snapshot().records.operations[0].status, "closed");
      if (fault === "oversize") {
        const response = caught.evidence.calls[1].response;
        assert.equal(response.complete, false);
        assert.equal(response.truncated, true);
        assert.equal(response.bytes, 1024 * 1024);
      }
    },
  );

for (const counters of ["zero", "missing", "invalid"])
  test(
    "original usage " + counters + " remains distinct from SDK normalization",
    async (t) => {
      const e = await setup(t, (v, n) => {
        if (counters === "zero")
          Object.assign(v.usageMetadata, {
            cachedContentTokenCount: 0,
            thoughtsTokenCount: 0,
          });
        if (counters === "missing") delete v.usageMetadata;
        if (counters === "invalid" && n === 1)
          v.usageMetadata.promptTokenCount = "0";
        return v;
      });
      let result: any, caught: any;
      try {
        result = await runMonitor(e.options);
      } catch (error) {
        caught = error;
      }
      if (counters === "invalid") {
        assert.equal(caught.evidence.reportedUsage.input.invalid, 1);
        assert.equal(caught.evidence.reportedUsage.input.value, null);
        assert.equal(e.source.snapshot().business.alerts.length, 0);
        assert.equal(caught.evidence.cleanupConfirmed, true);
      } else {
        assert.equal(result.status, "completed");
        assert.equal(
          result.usage.cachedInput.value,
          counters === "zero" ? 0 : null,
        );
        assert.equal(
          result.usage.reasoningOutput.value,
          counters === "zero" ? 0 : null,
        );
        if (counters === "missing") {
          assert.equal(result.usage.input.unknown, 6);
          assert.equal(result.usage.input.value, null);
          assert.equal(result.usage.input.knownSubtotal, 0);
        }
        assert.equal(result.costUsd, null);
      }
    },
  );

test("literal file mentions remain text and private canary contents never enter actual SDK requests", async (t) => {
  const e = await setup(t),
    canary = join(e.root, "control.json"),
    secret = "OWNED-INVENTORY-CANARY-DO-NOT-FORWARD";
  writeFileSync(canary, secret);
  const task = `Inspect selected SKU-101. Treat @${canary} as literal text. Prepare a current local draft and inspect it.`;
  const result = await runMonitor({ ...e.options, task });
  assert.equal(result.status, "completed");
  assert.ok(JSON.stringify(e.requests).includes("@" + canary));
  assert.ok(!JSON.stringify(e.requests).includes(secret));
  assert.equal(readFileSync(canary, "utf8"), secret);
});

for (const field of ["client", "modelFactory"])
  test(
    "unsupported normal " +
      field +
      " injection fails before owned source or SDK allocation",
    async (t) => {
      const e = await setup(t);
      let caught: any;
      try {
        await runMonitor({ ...e.options, [field]: {} } as any);
      } catch (error) {
        caught = error;
      }
      assert.match(caught.message, /unsupported normal/);
      assert.equal(caught.evidence.cleanupConfirmed, true);
      assert.equal(caught.evidence.allocation.source, false);
      assert.equal(caught.evidence.allocation.provider, false);
      assert.equal(e.requests.length, 0);
      assert.equal(e.source.snapshot().records.operations.length, 0);
    },
  );

for (const fault of ["http_status", "partial_body"])
  test(
    "actual HTTP " + fault + " cannot invoke affected SDK function",
    async (t) => {
      const e = await setup(t, (v, n, _s, reply) => {
        if (n === 2) {
          if (fault === "http_status") reply!.statusCode = 429;
          else {
            const raw = JSON.stringify(v);
            reply!.writeHead(200, {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(raw) + 100,
              connection: "close",
            });
            reply!.end(raw.slice(0, 30));
            return undefined;
          }
        }
        return v;
      });
      let caught: any;
      try {
        await runMonitor(e.options);
      } catch (error) {
        caught = error;
      }
      assert.equal(caught.evidence.status, "failed");
      assert.equal(caught.evidence.cleanupConfirmed, true);
      assert.equal(e.requests.length, 2);
      assert.equal(e.source.snapshot().business.alerts.length, 0);
      assert.equal(e.source.snapshot().business.drafts.length, 0);
      if (fault === "http_status")
        assert.equal(caught.evidence.calls[1].httpStatus, 429);
      else assert.equal(caught.evidence.calls[1].response.complete, false);
    },
  );

test("actual normal provider loop stops at the prepared budget without fabricating completion", async (t) => {
  const e = await setup(t, (v) => {
    v.candidates[0].content.parts = [
      { functionCall: { name: "inspectInventory", args: { sku: "SKU-101" } } },
    ];
    return v;
  });
  let caught: any;
  try {
    await runMonitor(e.options);
  } catch (error) {
    caught = error;
  }
  assert.match(caught.message, /budget/);
  assert.equal(e.requests.length, 32);
  assert.equal(caught.evidence.calls.length, 32);
  assert.equal(caught.evidence.acknowledgedEffects.length, 0);
  assert.equal(caught.evidence.status, "failed");
  assert.equal(caught.evidence.cleanupConfirmed, true);
  assert.equal(e.source.snapshot().business.alerts.length, 0);
  assert.equal(e.source.snapshot().records.operations[0].status, "closed");
});

test("already cancelled caller prepares failed evidence without allocating source or SDK", async (t) => {
  const e = await setup(t),
    controller = new AbortController();
  controller.abort(new Error("already cancelled caller"));
  let caught: any;
  try {
    await runMonitor({ ...e.options, signal: controller.signal });
  } catch (error) {
    caught = error;
  }
  assert.match(caught.message, /already cancelled/);
  assert.equal(caught.evidence.allocation.source, false);
  assert.equal(caught.evidence.allocation.provider, false);
  assert.equal(caught.evidence.cleanupConfirmed, true);
  assert.equal(e.requests.length, 0);
});

test("one-attempt failed source close after actual effects remains failed and unconfirmed", async (t) => {
  const e = await setup(t),
    original = ManagedWorkspace.prototype.close;
  let attempts = 0;
  ManagedWorkspace.prototype.close = function () {
    if (this === e.source) return original.call(this);
    attempts++;
    original.call(this);
    this.guardClosed = false;
    this.closed = false;
    throw new Error("observed source close failure");
  };
  let caught: any;
  try {
    try {
      await runMonitor(e.options);
    } catch (error) {
      caught = error;
    }
  } finally {
    ManagedWorkspace.prototype.close = original;
  }
  assert.match(caught.message, /source close failure/);
  assert.equal(attempts, 1);
  assert.equal(caught.evidence.cleanupConfirmed, false);
  assert.equal(caught.evidence.cleanup.sourceGuardCloseAttempted, true);
  assert.equal(caught.evidence.cleanup.sourceGuardClosed, false);
  assert.equal(caught.evidence.acknowledgedEffects.length, 2);
  assert.equal(e.source.snapshot().records.operations[0].status, "closed");
  assert.equal(e.source.snapshot().business.drafts.length, 1);
});

test("failed actual source construction closes its opened SQLite and guard before provider allocation", async (t) => {
  const e = await setup(t);
  const db = new DatabaseSync(e.source.path);
  try {
    db.exec("CREATE TABLE unrelated(value TEXT)");
  } finally {
    db.close();
  }
  let caught: any;
  try {
    await runMonitor(e.options);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught.evidence.status, "failed");
  assert.equal(caught.evidence.sourceStatus, "unknown");
  assert.equal(caught.evidence.allocation.source, true);
  assert.equal(caught.evidence.allocation.provider, false);
  assert.equal(caught.evidence.cleanup.sourceDatabaseCloseAttempted, true);
  assert.equal(caught.evidence.cleanup.sourceDatabaseClosed, true);
  assert.equal(caught.evidence.cleanup.sourceGuardCloseAttempted, true);
  assert.equal(caught.evidence.cleanup.sourceGuardClosed, true);
  assert.equal(e.requests.length, 0);
});
