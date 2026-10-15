// Preserve argparse v1 constructor-version behavior after the scoped v2 override.
// Upstream argparse remains installed with its original license and attribution.
const { readFileSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");

const core = createRequire(require.resolve("@mastra/core"));
const matter = createRequire(core.resolve("gray-matter"));
const yaml = createRequire(matter.resolve("js-yaml"));
const metadata = JSON.parse(readFileSync(yaml.resolve("argparse/package.json"), "utf8"));
if (metadata.version !== "2.0.1") throw new Error("Requalify the argparse compatibility repair for this dependency version");
const path = yaml.resolve("argparse");
const before = "// LEGACY (v1 compatibility), version\n        if (version) {\n            this.add_argument(";
const after = "// LEGACY (v1 compatibility), version\n        if (version) {\n            this.version = version // Preserve the legacy constructor option.\n            this.add_argument(";
const source = readFileSync(path, "utf8");
if (source.includes(after)) process.exit(0);
if (source.split(before).length !== 2) throw new Error("Unexpected argparse source; compatibility repair was not applied");
writeFileSync(path, source.replace(before, after));
