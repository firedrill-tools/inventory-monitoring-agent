#!/usr/bin/env node
/** Private model-free source authoring/inspection, without model capabilities. */
import { resolve } from "node:path";
import { ManagedWorkspace } from "./managed.js";
import { parseJSON } from "./json.js";
import type { InventoryEvent } from "./domain.js";

function main() {
  const args = process.argv.slice(2),
    command = args[0];
  if (!command || args.includes("--help")) {
    console.log(
      "Usage: inventory-state init|inspect|event --db FILE [--fixture FILE] [--sku ID ...] [--event-json JSON]",
    );
    return;
  }
  const allowed = new Set(["--db", "--fixture", "--sku", "--event-json"]),
    options = new Map<string, string[]>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !allowed.has(key) ||
      value === undefined ||
      value.startsWith("--") ||
      (key !== "--sku" && options.has(key))
    )
      throw new Error("exact private inventory command arguments required");
    options.set(key, [...(options.get(key) ?? []), value]);
  }
  const file = options.get("--db")?.[0];
  if (!file) throw new Error("--db required");
  if (!["init", "inspect", "event"].includes(command))
    throw new Error("unknown private inventory command");
  if (
    (command !== "init" && options.has("--fixture")) ||
    (command !== "inspect" && options.has("--sku")) ||
    (command !== "event" && options.has("--event-json"))
  )
    throw new Error("private argument belongs to another command");
  const fixture =
    options.get("--fixture")?.[0] ??
    resolve(import.meta.dirname, "../../fixtures/starter.json");
  const source =
    command === "init"
      ? ManagedWorkspace.seed(file, fixture)
      : new ManagedWorkspace(file);
  let result: unknown;
  try {
    if (command === "init")
      result = {
        initialized: true,
        database: source.path,
        instanceId: source.instanceId,
      };
    else if (command === "inspect")
      result = options.has("--sku")
        ? source.inspectIntent(options.get("--sku"))
        : source.snapshot();
    else {
      const raw = options.get("--event-json")?.[0];
      if (raw === undefined) throw new Error("--event-json required");
      result = source.event(parseJSON(Buffer.from(raw)) as InventoryEvent);
    }
  } finally {
    source.close();
  }
  console.log(JSON.stringify(result, null, 2));
}
try {
  main();
} catch (error) {
  console.log(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 2;
}
