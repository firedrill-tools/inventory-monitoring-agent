/** npm12 omits shrinkwrap from pack; pin the exercised publishable-lock format. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
    "CI",
  ]
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);
const result = spawnSync(
  "npm",
  [
    "exec",
    "--yes",
    "--package=npm@11.21.0",
    "--",
    "npm",
    "pack",
    ...process.argv.slice(2),
  ],
  { cwd: root, env, stdio: "inherit", timeout: 180000 },
);
if (result.error) throw result.error;
if (result.signal)
  throw new Error("pinned npm packaging interrupted: " + result.signal);
process.exitCode = result.status ?? 1;
