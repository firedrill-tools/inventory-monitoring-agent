/** Normal actual Agent/Google SDK/HTTP over a genuine scoped managed source. */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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
  mutate: (value: any, n: number, source: ManagedWorkspace) => any = (v) => v,
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
      );
      res.writeHead(200, {
        "content-type": "application/json",
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
