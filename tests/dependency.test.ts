import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const core = createRequire(require.resolve("@mastra/core"));
const matter = core("gray-matter");
const matterRequire = createRequire(core.resolve("gray-matter"));
const yaml = matterRequire("js-yaml");
const yamlCli = join(dirname(matterRequire.resolve("js-yaml")), "bin/js-yaml.js");

test("Mastra's front-matter parser still reads and round-trips its YAML data", () => {
  const parsed = matter("---\ntitle: Synthetic task\nflags:\n  - review\ncount: 2\n---\nBody\n");
  assert.deepEqual(parsed.data, { title: "Synthetic task", flags: ["review"], count: 2 });
  assert.equal(parsed.content, "Body\n");
  const roundTrip = matter(matter.stringify("Body\n", parsed.data));
  assert.deepEqual(roundTrip.data, parsed.data);
  assert.equal(roundTrip.content.trim(), "Body");
});

test("the legacy YAML CLI retains help, version and both stdin conversion modes", () => {
  for (const flag of ["--help", "--version"]) {
    const result = spawnSync(process.execPath, [yamlCli, flag], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    if (flag === "--version") assert.equal(result.stdout.trim(), matterRequire("js-yaml/package.json").version);
    else assert.match(result.stdout, /usage: js-yaml/);
  }
  const json = spawnSync(process.execPath, [yamlCli], { encoding: "utf8", input: "title: Synthetic\ncount: 2\n" });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { title: "Synthetic", count: 2 });
  const output = spawnSync(process.execPath, [yamlCli], { encoding: "utf8", input: '{"title":"Synthetic","count":2}' });
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(yaml.safeLoad(output.stdout), { title: "Synthetic", count: 2 });
});

test("invalid YAML exits nonzero through the preserved CLI error path", () => {
  const result = spawnSync(process.execPath, [yamlCli, "--compact"], { encoding: "utf8", input: "items: [unterminated" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected|flow collection|end of the stream/i);
});
