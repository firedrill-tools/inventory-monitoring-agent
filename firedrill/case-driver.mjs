import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { initialize, inspectCase as inspect } from '../dist/src/cases.js';
const [action, workspace, caseId] = process.argv.slice(2);
const controller = new AbortController();
const stop = () => controller.abort(new Error('Private source inspection interrupted.'));
for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, stop);
try {
  const result = action === 'init' ? await initialize(workspace, caseId) : await inspect(workspace);
  controller.signal.throwIfAborted();
  const bytes = Buffer.from(JSON.stringify(result));
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Private inspection exceeds its 64 MiB retained-file bound.');
  const path = join(dirname(workspace), action === 'init' ? 'initial-inspection.json' : 'inspection.json');
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600, flush: true });
  const keys = ['ok', 'root', 'instance_id', 'case_id', 'application_valid', 'application_error', 'original_seed_match', 'source_hashes', 'history_scope',
    'database', 'metrics', 'instanceId', 'caseId', 'originalSeedMatch', 'applicationValid', 'applicationError', 'runtimeReady', 'datasetSha256', 'definitionSha256', 'seedScope'];
  const summary = Object.fromEntries(keys.filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]]));
  console.log(JSON.stringify({ ...summary, fullInspection: { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }));
} catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
finally { for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(name, stop); }
