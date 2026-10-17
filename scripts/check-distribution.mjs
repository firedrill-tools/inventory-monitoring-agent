/** Three real fresh locked installations outside checkout, including an npm consumer. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyArchive } from "./verify-source.mjs";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  temporary = fs.mkdtempSync(path.join(tmpdir(), "inventory-distribution-"));
const output = path.join(root, "dist", "qualification");
fs.mkdirSync(output, { recursive: true });
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
env.MASTRA_OFFLINE = "1";
function run(label, command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(
    path.join(output, label + ".log"),
    result.stdout + "\n" + result.stderr,
  );
  if (result.status !== 0)
    throw Error(
      label +
        " failed: " +
        result.stdout.slice(-7000) +
        result.stderr.slice(-7000),
    );
  console.log(label + " passed");
  return result.stdout;
}
const node = (label, args, cwd = root) =>
  run(label, process.execPath, args, cwd);
try {
  run("build", "npm", ["run", "build"], root);
  const archive = JSON.parse(
    node("package-source", ["scripts/package-source.mjs"]),
  ).path;
  const original = fs.readFileSync(archive),
    proof = verifyArchive(archive, root);
  const fullBase = path.join(temporary, "full"),
    prodBase = path.join(temporary, "production");
  for (const destination of [fullBase, prodBase]) {
    fs.mkdirSync(destination);
    run(
      "extract-" + path.basename(destination),
      "tar",
      ["-xzf", archive, "-C", destination],
      temporary,
    );
    verifyArchive(archive, path.join(destination, "package"));
  }
  const full = path.join(fullBase, "package"),
    production = path.join(prodBase, "package");
  run("full-install", "npm", ["ci", "--no-audit", "--no-fund"], full);
  const fullSuite = run("full-suite", "npm", ["test"], full);
  assert.match(fullSuite, /(?:#|ℹ) tests 151\b/);
  assert.match(fullSuite, /(?:#|ℹ) pass 151\b/);
  assert.match(fullSuite, /(?:#|ℹ) fail 0\b/);
  node("full-populations", ["scripts/build-populations.mjs", "--check"], full);
  node(
    "full-installed",
    [
      path.join(full, "scripts/exercise-installed.mjs"),
      full,
      path.join(temporary, "full-outside"),
    ],
    temporary,
  );
  verifyArchive(archive, full);
  const repeat = path.join(temporary, "repeat.tar.gz");
  node("repeat-source", ["scripts/package-source.mjs", repeat], full);
  assert.deepEqual(fs.readFileSync(repeat), original);
  run(
    "production-install",
    "npm",
    ["ci", "--omit=dev", "--no-audit", "--no-fund"],
    production,
  );
  node(
    "production-installed",
    [
      path.join(production, "scripts/exercise-installed.mjs"),
      production,
      path.join(temporary, "production-outside"),
      "--production-only",
    ],
    temporary,
  );
  verifyArchive(archive, production);
  const packed = JSON.parse(
    node(
      "npm-pack",
      ["scripts/package-npm.mjs", "--json", "--pack-destination", temporary],
      root,
    ),
  );
  // npm10/11 emits an array; npm12 emits a package-name keyed object.
  const packRows = Array.isArray(packed) ? packed : Object.values(packed);
  assert.equal(packRows.length, 1);
  const pack = packRows[0];
  assert.equal(pack.name, "inventory-monitoring-agent");
  assert.equal(pack.filename, "inventory-monitoring-agent-0.2.0.tgz");
  const consumer = path.join(temporary, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({
      name: "private-inventory-qualification",
      version: "1.0.0",
      private: true,
      // npm ignores dependency-level overrides. The embedded application
      // requires this documented scoped dependency policy at its consumer root.
      overrides: JSON.parse(fs.readFileSync(path.join(root, "package.json")))
        .overrides,
    }),
  );
  run(
    "consumer-install",
    "npm",
    [
      "install",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      path.join(temporary, pack.filename),
    ],
    consumer,
  );
  // Recreate from the consumer's actual generated lock, rather than accepting an install alone.
  run(
    "consumer-ci",
    "npm",
    ["ci", "--omit=dev", "--no-audit", "--no-fund"],
    consumer,
  );
  const installed = path.join(
    consumer,
    "node_modules",
    "inventory-monitoring-agent",
  );
  assert.ok(fs.existsSync(path.join(installed, "npm-shrinkwrap.json")));
  // npm12 blocks dependency lifecycle scripts by default. Run only this
  // private package's declared guarded repair, also valid when scripts ran.
  run("consumer-parser-repair", "npm", ["run", "postinstall"], installed);
  node(
    "package-installed",
    [
      path.join(installed, "scripts/exercise-installed.mjs"),
      installed,
      path.join(temporary, "consumer-outside"),
      "--production-only",
    ],
    temporary,
  );
  const help = run(
    "installed-bin",
    path.join(consumer, "node_modules", ".bin", "inventory"),
    ["--help"],
    temporary,
  );
  assert.match(help, /Usage: inventory/);
  const report = {
    status: "passed",
    temporary,
    archive: proof,
    installs: 3,
    fullChecks: 151,
    allTwelvePrivateCases: true,
    normalActualSdkCli: 15,
    signalRuns: 9,
    missingKeyRuns: 3,
    portableArchiveEqual: true,
    liveProvider: false,
    actualPurchase: null,
  };
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} catch (error) {
  console.error("Fresh installation evidence retained at " + temporary);
  throw error;
}
