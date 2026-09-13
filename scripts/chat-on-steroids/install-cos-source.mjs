#!/usr/bin/env node

import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const COS_VERSION = '2.1.0';
const COS_PINNED_COMMIT = '1517d66dac1e7452f63b7452c88479c92a554768';
const cosDir = process.env.COS_SOURCE_DIR ? path.resolve(process.env.COS_SOURCE_DIR) : null;
if (!cosDir) {
  console.error(`COS_SOURCE_DIR is required and must point to a writable Chat On Steroids ${COS_VERSION} checkout`);
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const staged = path.join(repoRoot, 'patches', `chat-on-steroids-${COS_VERSION}`, 'src', 'main', 'runtime-server.ts');
const target = path.join(cosDir, 'src', 'main', 'runtime-server.ts');
const indexPath = path.join(cosDir, 'src', 'main', 'index.ts');
const packagePath = path.join(cosDir, 'package.json');

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function once(text, needle, replacement, label) {
  if (text.includes(replacement)) return text;
  const first = text.indexOf(needle);
  if (first < 0) throw new Error(`Expected CoS ${COS_VERSION} anchor not found: ${label}`);
  if (text.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`CoS anchor is ambiguous (${label}); refusing to patch`);
  }
  return `${text.slice(0, first)}${replacement}${text.slice(first + needle.length)}`;
}

const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
if (pkg.name !== 'chat-on-steroids' || pkg.version !== COS_VERSION) {
  throw new Error(`Expected chat-on-steroids ${COS_VERSION} (CI pin ${COS_PINNED_COMMIT}), found ${pkg.name ?? 'unknown'} ${pkg.version ?? 'unknown'}`);
}

let runtime = await readFile(staged, 'utf8');
runtime = runtime
  .replace("from '../../../../src/main/durable.js'", "from './durable.js'")
  .replace("from '../../../../src/main/logger.js'", "from './logger.js'")
  .replace("from '../../../../src/main/session/input.js'", "from './session/input.js'")
  .replace("from '../../../../src/main/session/start-input.js'", "from './session/start-input.js'")
  .replace("from '../../../../src/main/session/store.js'", "from './session/store.js'")
  .replace("from '../../../../src/shared/session.js'", "from '../shared/session.js'")
  .replace(/\/\*\n \* Staged copy[\s\S]*?CoS checkout\.\n \*\/\n\n/, '');

if (await exists(target)) {
  const current = await readFile(target, 'utf8');
  if (current !== runtime) throw new Error('src/main/runtime-server.ts already exists with different content; refusing to overwrite it');
  console.log('runtime-server.ts already installed');
} else {
  await writeFile(target, runtime, { encoding: 'utf8', flag: 'wx' });
  console.log('installed src/main/runtime-server.ts');
}

let index = await readFile(indexPath, 'utf8');
index = once(
  index,
  "import { getChatModels, restoreChatModels, startChatModelDiscovery } from './chat-models.js';",
  "import { getChatModels, restoreChatModels, startChatModelDiscovery } from './chat-models.js';\nimport { shutdownRuntimeServer, startRuntimeServer } from './runtime-server.js';",
  'runtime import'
);
index = once(
  index,
  "  logInfo('app started');",
  "  logInfo('app started');\n\n  try { await startRuntimeServer(); }\n  catch (error) { logError(`CoS runtime failed to start: ${error instanceof Error ? error.message : String(error)}`); }\n  if (windowActivation.isDisabled()) return;",
  'runtime startup'
);
index = once(
  index,
  "      { name: 'admission/drain', budgetMs: 40_000, run: () => [shutdownConnection(), shutdownBridge()] },",
  "      { name: 'admission/drain', budgetMs: 40_000, run: () => [shutdownRuntimeServer(), shutdownConnection(), shutdownBridge()] },",
  'runtime shutdown'
);
await writeFile(indexPath, index, 'utf8');

console.log(`patched Chat On Steroids ${COS_VERSION} source`);
console.log('Next: run `npm run typecheck && npm test` in the CoS checkout before packaging/installing.');
