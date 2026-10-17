/** Real installed CLI/SDK qualification. Only owned loopback HTTP and synthetic keys. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
const root = fs.realpathSync(process.argv[2]),
  outside = path.resolve(process.argv[3]);
fs.mkdirSync(outside, { recursive: true });
const require = createRequire(path.join(root, "package.json"));
for (const name of ["@mastra/core/agent", "@ai-sdk/google", "undici", "zod"]) {
  const resolved = fs.realpathSync(require.resolve(name));
  assert.ok(
    !resolved.includes("/Repositories/"),
    `checkout dependency: ${resolved}`,
  );
}
if (process.argv.includes("--production-only"))
  assert.throws(() => require.resolve("typescript"));
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "SystemRoot", "WINDIR"]
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);
env.MASTRA_OFFLINE = "1";
const core = createRequire(require.resolve("@mastra/core"));
const matter = core("gray-matter");
const matterRequire = createRequire(core.resolve("gray-matter"));
const yaml = matterRequire("js-yaml");
assert.deepEqual(matter("---\ntitle: Installed\ncount: 2\n---\nBody\n").data, {
  title: "Installed",
  count: 2,
});
const yamlCli = path.join(
  path.dirname(matterRequire.resolve("js-yaml")),
  "bin/js-yaml.js",
);
for (const flag of ["--help", "--version"]) {
  const p = spawnSync(process.execPath, [yamlCli, flag], {
    cwd: outside,
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(p.status, 0, p.stderr);
  if (flag === "--version")
    assert.equal(
      p.stdout.trim(),
      matterRequire("js-yaml/package.json").version,
    );
}
assert.deepEqual(
  yaml.safeLoad(yaml.safeDump({ title: "Installed", count: 2 })),
  { title: "Installed", count: 2 },
);
const entry = (name) => path.join(root, "dist/src", name + ".js");
function command(name, args, status = 0) {
  const p = spawnSync(process.execPath, [entry(name), ...args], {
    cwd: outside,
    env,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(p.status, status, p.stdout.slice(-8000) + p.stderr);
  return JSON.parse(p.stdout);
}
function files(dir) {
  const result = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name),
      stat = fs.lstatSync(full);
    assert.ok(!stat.isSymbolicLink());
    if (stat.isDirectory())
      for (const [k, v] of Object.entries(files(full)))
        result[name + "/" + k] = v;
    else result[name] = fs.readFileSync(full).toString("base64");
  }
  return result;
}
const listed = command("cases-cli", ["list"]);
const ids = listed.cases.map((c) => c.id);
assert.equal(ids.length, 12);
for (const id of ids) {
  const info = command("cases-cli", [
    "init",
    "--case",
    id,
    "--root",
    path.join(outside, id),
  ]);
  assert.deepEqual(
    command("cases-cli", ["inspect", "--root", info.root]),
    info,
  );
  assert.ok(
    ["operations", "observations", "decisions"].every(
      (k) => info.source.records[k].length === 0,
    ),
  );
  if (id === "busy_fresh_cycle") {
    assert.equal(info.metrics.items, 48);
    assert.equal(info.metrics.events, 96);
    assert.equal(info.source.fixture.history.length, 128);
  }
  fs.writeFileSync(
    path.join(info.root, "kept-receipt.json"),
    '{"kind":"installed preservation probe"}\n',
  );
  const before = files(info.root);
  const reset = command("cases-cli", [
    "reset",
    "--root",
    info.root,
    "--new-root",
    path.join(outside, "reset-" + id),
  ]);
  assert.deepEqual(files(info.root), before);
  assert.notEqual(reset.instanceId, info.instanceId);
  assert.notEqual(reset.seedSha256, info.seedSha256);
  assert.deepEqual(reset.source.business, info.source.business);
  assert.ok(
    ["operations", "observations", "decisions"].every(
      (k) => reset.source.records[k].length === 0,
    ),
  );
}
// Default installed starter is used without an external fixture path.
const ordinary = path.join(outside, "default.db");
command("managed-cli", ["init", "--db", ordinary]);
assert.equal(
  command("managed-cli", ["inspect", "--db", ordinary]).business.items.length,
  3,
);
const key = "synthetic-installed-inventory-key",
  model = "google/gemini-2.5-flash";
const parts = [
  { functionCall: { name: "inspectInventory", args: {} } },
  { functionCall: { name: "evaluateInventory", args: { sku: "SKU-101" } } },
  { functionCall: { name: "inspectInventory", args: {} } },
  {
    functionCall: {
      name: "prepareReplenishment",
      args: { sku: "SKU-101", expectedRevision: 2 },
    },
  },
  { functionCall: { name: "inspectInventory", args: {} } },
  {
    text: "Current inventory inspected and local replenishment draft prepared. No purchase placed.",
  },
];
async function normal(mode) {
  const info = command("cases-cli", [
    "init",
    "--case",
    "starter_low",
    "--root",
    path.join(outside, "normal-" + mode),
  ]);
  let count = 0,
    release,
    serverError,
    heldResolve;
  const held = new Promise((done) => {
      heldResolve = done;
    }),
    released = new Promise((done) => {
      release = done;
    });
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(req.url, "/v1beta/models/gemini-2.5-flash:generateContent");
      assert.equal(req.headers["x-goog-api-key"], key);
      assert.ok(!JSON.stringify(body).includes(info.instanceId));
      const n = ++count;
      if (mode.startsWith("SIG") && n === 4) {
        heldResolve();
        await released;
      }
      const value = {
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [parts[n - 1]] },
            finishReason:
              mode === "late-failure" && n === 6 ? "MAX_TOKENS" : "STOP",
          },
        ],
        responseId: "installed-" + mode + "-" + n,
        modelVersion: "gemini-2.5-flash-synthetic",
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 2,
          totalTokenCount: 12,
        },
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    } catch (error) {
      serverError = error;
      res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1beta`;
  const args = [
    entry("cli"),
    "run",
    "--db",
    info.database,
    "--task",
    "Inspect current selected stock and prepare a needed local draft.",
    "--sku",
    "SKU-101",
    "--model",
    model,
    "--base-url",
    endpoint,
    "--allow-writes",
    "--intent-json",
    JSON.stringify(info.intent),
    "--output",
    path.join(info.root, "receipts"),
    "--timeout-ms",
    "120000",
  ];
  const child = spawn(process.execPath, args, {
    cwd: outside,
    env: { ...env, GOOGLE_API_KEY: key },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    timer;
  child.stdout.on("data", (v) => {
    stdout += v;
  });
  child.stderr.on("data", (v) => {
    stderr += v;
  });
  const exit = new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => done({ code, signal }));
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Error("installed normal CLI timeout: " + mode)),
      120000,
    );
  });
  try {
    if (mode.startsWith("SIG")) {
      await Promise.race([
        held,
        exit.then(() => {
          throw Error("child exited before held request: " + stderr + stdout);
        }),
        timeout,
      ]);
      assert.equal(child.kill(mode), true);
    }
    const result = await Promise.race([exit, timeout]);
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, mode === "success" ? 0 : 1, stdout + stderr);
    const output = JSON.parse(stdout),
      receipt = JSON.parse(fs.readFileSync(output.receiptPath));
    assert.equal(output.cleanupConfirmed, true);
    assert.equal(receipt.cleanup.scopeClosed, true);
    for (const field of [
      "flowDrained",
      "providerClosed",
      "sourceDatabaseClosed",
      "sourceGuardClosed",
    ])
      assert.equal(receipt.cleanup[field], true);
    const current = command("cases-cli", ["inspect", "--root", info.root]);
    assert.equal(current.source.records.operations[0].status, "closed");
    assert.equal(current.source.business.alerts.length, 1);
    const expected = mode.startsWith("SIG") ? 1 : 2;
    assert.equal(receipt.acknowledgedEffects.length, expected);
    assert.equal(current.source.business.drafts.length, expected - 1);
    assert.equal(count, mode.startsWith("SIG") ? 4 : 6);
    assert.equal(receipt.status, mode === "success" ? "completed" : "failed");
    if (mode === "success")
      assert.equal(output.business.workflowComplete, true);
    if (mode === "late-failure")
      assert.equal(output.business.workflowComplete, true);
    const before = files(info.root),
      reset = command("cases-cli", [
        "reset",
        "--root",
        info.root,
        "--new-root",
        path.join(outside, "after-" + mode),
      ]);
    assert.deepEqual(files(info.root), before);
    assert.notEqual(reset.instanceId, info.instanceId);
    assert.equal(reset.source.business.alerts.length, 0);
    assert.equal(reset.source.records.operations.length, 0);
    assert.equal(serverError, undefined);
  } finally {
    clearTimeout(timer);
    release();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exit;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}
for (const mode of ["success", "late-failure", "SIGINT", "SIGTERM", "SIGHUP"])
  await normal(mode);
const missing = command("cases-cli", [
  "init",
  "--case",
  "starter_low",
  "--root",
  path.join(outside, "missing-key"),
]);
const noKey = command(
  "cli",
  [
    "run",
    "--db",
    missing.database,
    "--task",
    "Inspect current selected stock.",
    "--model",
    model,
    "--output",
    path.join(missing.root, "receipts"),
  ],
  1,
);
assert.match(noKey.error, /GOOGLE_API_KEY/);
const receipt = JSON.parse(fs.readFileSync(noKey.receiptPath));
assert.equal(receipt.calls.length, 0);
assert.equal(receipt.cleanupConfirmed, true);
assert.ok(Object.values(receipt.allocation).every((v) => v === false));
assert.equal(
  command("cases-cli", ["inspect", "--root", missing.root]).source.records
    .operations.length,
  0,
);
console.log(
  JSON.stringify({
    root,
    cases: 12,
    resets: 12,
    normalOwnedSdkCli: 5,
    signals: 3,
    missingKey: true,
    productionOnly: process.argv.includes("--production-only"),
  }),
);
