import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { runMonitor } from "./agent.js";
import { Workspace } from "./workspace.js";

const arg = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const required = (args: string[], name: string) => {
  const value = arg(args, name);
  if (!value || value.startsWith("--")) throw new Error(`${name} required`);
  return value;
};
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) {
    console.log(
      "Usage: inventory init|inspect|event|run --state workspace.json [--sku SKU-101] [--id E-1 --sequence 101 --kind sale --value 4] [--task '...'] [--allow-writes]",
    );
    return;
  }
  const command = args[0];
  const file = resolve(arg(args, "--state") || "workspace.json");
  if (command === "init") {
    if (existsSync(file)) throw new Error("workspace already exists");
    copyFileSync(resolve("fixtures/starter.json"), file);
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
    if (command === "run") {
      console.log(
        JSON.stringify(
          await runMonitor({
            statePath: file,
            task: required(args, "--task"),
            model:
              arg(args, "--model") ||
              process.env.INVENTORY_MODEL ||
              "google/gemini-2.5-flash",
            allowWrites: args.includes("--allow-writes"),
          }),
          null,
          2,
        ),
      );
      return;
    }
    throw new Error(`unknown command: ${command}`);
  } finally {
    workspace.close();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
