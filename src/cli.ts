import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { runMonitor } from "./runtime.js";
import { Workspace } from "./workspace.js";
import { parseJSON } from "./json.js";
import type { Intent } from "./managed-state.js";

const arg = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const required = (args: string[], name: string) => {
  const value = arg(args, name);
  if (!value || value.startsWith("--")) throw new Error(`${name} required`);
  return value;
};
async function run(args: string[]) {
  const valued = new Set([
      "--db",
      "--task",
      "--model",
      "--base-url",
      "--intent-json",
      "--sku",
      "--output",
      "--timeout-ms",
    ]),
    options = new Map<string, string[]>();
  let writes = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--allow-writes") {
      if (writes) throw new Error("duplicate write flag");
      writes = true;
      continue;
    }
    const value = args[++i];
    if (
      !valued.has(key) ||
      value === undefined ||
      value.startsWith("--") ||
      (key !== "--sku" && options.has(key))
    )
      throw new Error("exact normal inventory run arguments required");
    options.set(key, [...(options.get(key) ?? []), value]);
  }
  const controller = new AbortController(),
    signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const,
    handlers = signals.map((signal) => ({
      signal,
      callback: () =>
        controller.abort(new Error(signal + " cancelled inventory run")),
    }));
  for (const { signal, callback } of handlers) process.on(signal, callback);
  try {
    const database = options.get("--db")?.[0],
      task = options.get("--task")?.[0];
    if (!database || !task)
      throw new Error(
        "--db and --task required; initialize a private managed source first",
      );
    const intentRaw = options.get("--intent-json")?.[0];
    return await runMonitor({
      database,
      task,
      model: options.get("--model")?.[0],
      baseURL: options.get("--base-url")?.[0],
      allowWrites: writes,
      intent:
        intentRaw === undefined
          ? undefined
          : (parseJSON(Buffer.from(intentRaw)) as Intent),
      skus: options.get("--sku"),
      outputRoot: options.get("--output")?.[0],
      timeoutMs: options.has("--timeout-ms")
        ? Number(options.get("--timeout-ms")![0])
        : undefined,
      signal: controller.signal,
    });
  } finally {
    for (const { signal, callback } of handlers)
      process.removeListener(signal, callback);
  }
}
async function main() {
  const args = process.argv.slice(2),
    command = args[0];
  if (!command || args.includes("--help")) {
    console.log(
      "Usage: inventory run --db FILE --task TEXT [--sku ID ... --model google/MODEL --allow-writes --intent-json JSON --output DIR --timeout-ms N]. Human JSON seam: init|inspect|event --state FILE. Private managed source: inventory:state.",
    );
    return;
  }
  if (command === "run") {
    console.log(JSON.stringify(await run(args.slice(1)), null, 2));
    return;
  }
  const file = resolve(arg(args, "--state") ?? "workspace.json");
  if (command === "init") {
    if (existsSync(file)) throw new Error("workspace already exists");
    copyFileSync(
      resolve(import.meta.dirname, "../../fixtures/starter.json"),
      file,
      1,
    );
    console.log(JSON.stringify({ file, initialized: true }));
    return;
  }
  const workspace = new Workspace(file);
  try {
    if (command === "inspect") {
      console.log(
        JSON.stringify(workspace.inspect(arg(args, "--sku")), null, 2),
      );
      return;
    }
    if (command === "event") {
      console.log(
        JSON.stringify(
          workspace.applyEvent({
            id: required(args, "--id"),
            sku: required(args, "--sku"),
            sequence: Number(required(args, "--sequence")),
            kind: required(args, "--kind") as
              | "sale"
              | "receipt"
              | "stocktake"
              | "threshold",
            value: Number(required(args, "--value")),
          }),
          null,
          2,
        ),
      );
      return;
    }
    throw new Error("unknown inventory command");
  } finally {
    workspace.close();
  }
}
main().catch((error: unknown) => {
  const e = error as any;
  console.log(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        receiptPath: e?.receiptPath ?? null,
        business: e?.evidence?.observedBusiness ?? null,
        acknowledgedEffects: e?.evidence?.acknowledgedEffects ?? null,
        cleanupConfirmed: e?.evidence?.cleanupConfirmed ?? null,
        usage: e?.evidence?.reportedUsage ?? null,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
