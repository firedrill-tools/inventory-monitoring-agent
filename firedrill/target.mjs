import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { ApplicationError, commandMain, invokeCLI, privateDirectory } from './adapter-runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const cases = new Set(["starter_low", "starter_on_order", "starter_repeat", "busy_fresh_cycle", "busy_current_drafts", "busy_on_order", "ambiguous_threshold_drop", "ambiguous_recovery_reentry", "ambiguous_receipt", "boundary_last_safe", "boundary_duplicates_overflow", "boundary_unicode_maximum"]);
export async function runApplication(input, parameters, signal, invocation) {
  if (Object.keys(input).some(key => !['caseId', 'action', 'task', 'skus', 'allowWrites', 'intent'].includes(key)) || !cases.has(input.caseId) || !['run', 'inspect'].includes(input.action) ||
      typeof input.task !== 'string' || !input.task.trim() || input.task.length > 8000 || input.task.includes('\0') || !Array.isArray(input.skus) || input.skus.length < 1 || input.skus.length > 128 || !input.skus.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)) || typeof input.allowWrites !== 'boolean' ||
      (input.allowWrites ? !input.intent || typeof input.intent !== 'object' || Array.isArray(input.intent) || JSON.stringify(input.intent).length > 8000 : input.intent !== null) || (input.action === 'inspect' && input.allowWrites)) throw new Error('Select a reviewed case, exact SKUs/task and independent literal write grant/caller intent.');
  const directory = await privateDirectory(root, invocation), workspace = join(directory, 'workspace');
  try {
    const initialized = await invokeCLI([process.execPath, 'firedrill/case-driver.mjs', 'init', workspace, input.caseId], { cwd: root, signal });
    const db = initialized.database;
    if (typeof db !== 'string' || !db.startsWith(workspace + '/')) throw new Error('Initialized database is outside its owned workspace.');
    const argv = input.action === 'inspect' ? [process.execPath, 'firedrill/case-driver.mjs', 'inspect', workspace] : [process.execPath, 'dist/src/cli.js', 'run', '--db', db, '--task', input.task, ...input.skus.flatMap(id => ['--sku', id]), '--output', join(directory, 'receipts')];
    if (input.action === 'run') {
      if (input.allowWrites) argv.push('--allow-writes', '--intent-json', JSON.stringify(input.intent));
      if (parameters.model) argv.push('--model', parameters.model);
    }
    return { executionKind: input.action === 'inspect' ? 'application_state_inspection' : 'native_mastra_gemini', application: await invokeCLI(argv, { cwd: root, signal }), localState: { directory, workspaceRoot: workspace, databaseFile: db } };
  } catch (error) { if (error instanceof ApplicationError) error.evidence.runDirectory = directory; throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await commandMain(runApplication);
