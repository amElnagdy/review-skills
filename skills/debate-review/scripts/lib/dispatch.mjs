// Send a brief to an implementer through its delegate-skills relay, read-only, and get the JSON back.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { json, log } from './shell.mjs';

// ---------- locate delegate-skills ----------

function skillRoots() {
  const candidates = [
    process.env.DELEGATE_SKILLS_DIR,
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.codex', 'skills'),
  ];
  return candidates.filter(Boolean).filter(dir => fs.existsSync(dir));
}

function findScript(skill, script) {
  for (const root of skillRoots()) {
    const candidate = path.join(root, skill, 'scripts', script);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot find ${skill}/scripts/${script}. Install delegate-skills (looked in: ${skillRoots().join(', ') || 'no skills dir'})`);
}

// ---------- lanes ----------

/**
 * Decide who plays a role. An explicit implementer wins; otherwise read the lane from the fleet config.
 * Returns { implementer, lane }. lane is null when the implementer was given explicitly.
 */
export function resolveRole(role, { explicit, lane, cwd }) {
  if (explicit) return { implementer: explicit, lane: null };

  const config = json('node', [findScript('delegate-setup', 'config.mjs'), 'load', '--cwd', cwd]);
  const entry = config.lanes && config.lanes[lane];
  if (!entry) {
    throw new Error(`lane "${lane}" is not configured. Run delegate-setup, or pass --${role} <implementer>`);
  }
  return { implementer: entry.implementer, lane };
}

// ---------- read-only capability ----------

const probeCache = new Map();

/** Ask the relay itself whether it has a --read-only mode (so new relays work without a code change). */
function supportsReadOnly(relayPath) {
  if (!probeCache.has(relayPath)) {
    const help = spawnSync('node', [relayPath, '--help'], { encoding: 'utf8' });
    const combined = `${help.stdout || ''}${help.stderr || ''}`;
    probeCache.set(relayPath, /--read-only/.test(combined));
  }
  return probeCache.get(relayPath);
}

// ---------- dispatch ----------

/**
 * Run one implementer on a brief, read-only, inside `cwd`. Artifacts land in `<outDir>/<role>/`.
 * Returns { text, seconds } where text is the implementer's final message.
 */
export function dispatch({ role, who, brief, cwd, outDir, timeout }) {
  const relay = findScript(`${who.implementer}-delegate`, 'relay.mjs');
  if (!supportsReadOnly(relay)) {
    throw new Error(`${who.implementer}-delegate has no --read-only mode; choose another ${role} implementer`);
  }

  const dir = path.join(outDir, role);
  fs.mkdirSync(dir, { recursive: true });
  const briefPath = path.join(dir, 'brief.md');
  fs.writeFileSync(briefPath, brief);

  const args = [relay, '--brief', briefPath, '--cd', cwd, '--read-only', '--out-dir', dir, '--timeout', timeout];
  if (who.lane) args.push('--lane', who.lane);

  log(`${role}: ${who.implementer}${who.lane ? ` (lane ${who.lane})` : ''} …`);
  const started = Date.now();
  const proc = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  const seconds = Math.round((Date.now() - started) / 1000);

  const resultPath = path.join(dir, 'result.json');
  if (!fs.existsSync(resultPath)) {
    throw new Error(`${role}: relay exited ${proc.status} without writing result.json`);
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (result.status !== 'completed') {
    throw new Error(`${role}: relay finished with status "${result.status}" (see ${dir})`);
  }
  if (result.readOnlyViolation === true) {
    log(`WARNING ${role}: relay reported a read-only violation. Inspect ${dir}`);
  }

  log(`${role}: done in ${seconds}s`);
  return { text: result.finalMessage || '', seconds };
}

// ---------- parse the answer ----------

/** Pull the JSON document out of an implementer's final message (last ```json block wins). */
export function extractJson(message) {
  const blocks = [...message.matchAll(/```json\s*([\s\S]*?)```/g)].map(m => m[1]);
  const candidates = blocks.length > 0
    ? blocks.reverse()
    : [message.slice(message.indexOf('{'), message.lastIndexOf('}') + 1)];

  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the next block */ }
  }
  throw new Error('implementer returned no parseable JSON block');
}

/** Throw unless the document carries the schema id we asked for. */
export function expectSchema(doc, schema, role) {
  if (!doc || doc.schema !== schema) {
    throw new Error(`${role}: expected schema ${schema}, got ${doc && doc.schema}`);
  }
  return doc;
}
