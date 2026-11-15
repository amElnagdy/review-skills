import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
const AGENT_CONFIG = path.join(ROOT, 'skills/debate-review/scripts/lib/agent-config.mjs');

const REQUIRED_PATHS = ['.claude', '.codex', '.opencode', 'opencode.json', 'opencode.jsonc', '.mcp.json'];

function gitInit(dir, branch = 'main') {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-b', branch, dir], { encoding: 'utf8' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  spawnSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
}

function commitAll(dir, message) {
  spawnSync('git', ['-C', dir, 'add', '-A']);
  const result = spawnSync('git', ['-C', dir, 'commit', '-m', message], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function writeRelay(skillsDir, name, body) {
  const dir = path.join(skillsDir, `${name}-delegate`, 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'relay.mjs'), `
if (process.argv.includes('--help')) { console.log('--read-only'); process.exit(0); }
const fs = await import('node:fs');
const path = await import('node:path');
const { spawnSync } = await import('node:child_process');
const out = process.argv[process.argv.indexOf('--out-dir') + 1];
const cwd = process.argv[process.argv.indexOf('--cd') + 1];
${body}`);
}

function presentAt(root, rel) {
  try {
    fs.lstatSync(path.join(root, ...rel.split('/')));
    return true;
  } catch {
    return false;
  }
}

test('AGENT_CONFIG_PATHS is the single list and includes the known project-config vectors', async () => {
  const { AGENT_CONFIG_PATHS } = await import(AGENT_CONFIG);
  assert.ok(Array.isArray(AGENT_CONFIG_PATHS) && AGENT_CONFIG_PATHS.length > 0);
  for (const name of REQUIRED_PATHS) {
    assert.ok(AGENT_CONFIG_PATHS.includes(name), `missing ${name}`);
  }
  assert.ok(AGENT_CONFIG_PATHS.includes('.cursor'), 'Cursor project config (.cursor/hooks.json, mcp.json) belongs in the list');
  for (const name of AGENT_CONFIG_PATHS) {
    assert.equal(path.isAbsolute(name), false);
    assert.ok(!name.split(/[\\/]/).includes('..'), name);
  }
});

test('sanitizeAgentConfig removes planted config and unlinks symlinks without touching their targets', async () => {
  const { sanitizeAgentConfig, AGENT_CONFIG_PATHS } = await import(AGENT_CONFIG);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-agent-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-agent-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'SECRET'), 'keep-me');
    for (const rel of AGENT_CONFIG_PATHS) {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const base = rel.split('/').pop();
      if (base.includes('.', 1)) fs.writeFileSync(abs, '{}\n');
      else fs.mkdirSync(abs, { recursive: true });
    }
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{"hooks":{}}');
    fs.writeFileSync(path.join(root, 'src.js'), 'console.log(1)\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# keep\n');
    fs.rmSync(path.join(root, '.codex'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(root, '.codex'));
    fs.rmSync(path.join(root, '.opencode'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.opencode'));
    fs.symlinkSync(path.join(outside, 'SECRET'), path.join(root, '.opencode', 'plugin.js'));

    sanitizeAgentConfig(root);

    for (const name of AGENT_CONFIG_PATHS) {
      assert.equal(presentAt(root, name), false, `${name} should be gone`);
    }
    assert.equal(presentAt(root, '.claude/settings.json'), false);
    assert.equal(fs.readFileSync(path.join(root, 'src.js'), 'utf8'), 'console.log(1)\n');
    assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '# keep\n');
    assert.equal(fs.readFileSync(path.join(outside, 'SECRET'), 'utf8'), 'keep-me');
    assert.equal(fs.existsSync(outside), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('sanitizeAgentConfig refuses to strip a protected tree', async () => {
  const { sanitizeAgentConfig } = await import(AGENT_CONFIG);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-agent-protect-'));
  try {
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{}\n');
    assert.throws(() => sanitizeAgentConfig(dir, { protect: dir }), /protected tree/);
    assert.equal(presentAt(dir, '.mcp.json'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sanitizeAgentConfig does not follow a symlink parent when removing a nested path', async () => {
  const { sanitizeAgentConfig } = await import(AGENT_CONFIG);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-agent-nested-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-agent-vscode-'));
  try {
    fs.writeFileSync(path.join(outside, 'mcp.json'), '{"mcpServers":{"evil":{}}}');
    fs.writeFileSync(path.join(outside, 'settings.json'), '{"keep":true}');
    fs.symlinkSync(outside, path.join(root, '.vscode'));

    sanitizeAgentConfig(root);

    assert.equal(presentAt(root, '.vscode'), false);
    assert.equal(fs.readFileSync(path.join(outside, 'mcp.json'), 'utf8'), '{"mcpServers":{"evil":{}}}');
    assert.equal(fs.readFileSync(path.join(outside, 'settings.json'), 'utf8'), '{"keep":true}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('review-pr --help mentions stripping agent config from the disposable checkout', () => {
  const result = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /stripped from the\n?disposable checkout/s);
  assert.match(result.stdout, /--check warns/);
});

test('review-pr --local strips agent config before dispatch, keeps the user tree, and still diffs those paths', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-agent-src-'));
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-agent-skills-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-agent-out-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-agent-link-'));
  const probe = path.join(out, 'probe.ndjson');
  try {
    gitInit(src);
    fs.writeFileSync(path.join(src, 'app.js'), 'export default 1\n');
    commitAll(src, 'base');
    spawnSync('git', ['-C', src, 'checkout', '-b', 'topic']);

    fs.mkdirSync(path.join(src, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(src, '.claude', 'settings.json'), '{"hooks":{}}');
    fs.writeFileSync(path.join(src, '.mcp.json'), '{"mcpServers":{"evil":{"command":"false"}}}');
    fs.writeFileSync(path.join(outside, 'SECRET'), 'keep-me');
    fs.symlinkSync(outside, path.join(src, '.codex'));
    commitAll(src, 'plant agent config');

    writeRelay(skills, 'probe', `
const role = path.basename(out);
const exists = (rel) => {
  try { fs.lstatSync(path.join(cwd, rel)); return true; } catch { return false; }
};
const diffNames = spawnSync('git', ['-C', cwd, 'diff', '--name-only', 'HEAD~1', 'HEAD'], { encoding: 'utf8' }).stdout;
fs.appendFileSync(process.env.AGENT_CONFIG_PROBE, JSON.stringify({
  role, cwd,
  claudeSettings: exists('.claude/settings.json'),
  mcp: exists('.mcp.json'),
  codex: exists('.codex'),
  diffNames,
}) + '\\n');
const schema = role === 'debate'
  ? { schema: 'debate-review.debate.v1', verdicts: [], new_findings: [] }
  : { schema: 'debate-review.findings.v1', verdict: 'approve', summary: 'clean', findings: [] };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({
  status: 'completed',
  finalMessage: '\`\`\`json\\n' + JSON.stringify(schema) + '\\n\`\`\`',
}));
`);

    const result = spawnSync('node', [SCRIPT, '--local', '--repo-dir', src, '--out-dir', out,
      '--base', 'main', '--main', 'probe', '--debate', 'probe'], {
      encoding: 'utf8',
      env: { ...process.env, DELEGATE_SKILLS_DIR: skills, AGENT_CONFIG_PROBE: probe },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);

    const probes = fs.readFileSync(probe, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(probes.length >= 2, 'main and debate must both dispatch');
    for (const row of probes) {
      assert.equal(row.claudeSettings, false, `${row.role} saw .claude/settings.json`);
      assert.equal(row.mcp, false, `${row.role} saw .mcp.json`);
      assert.equal(row.codex, false, `${row.role} saw .codex`);
      assert.match(row.diffNames, /\.claude\/settings\.json/);
      assert.match(row.diffNames, /\.mcp\.json/);
      assert.match(row.diffNames, /\.codex/);
      assert.notEqual(path.resolve(row.cwd), path.resolve(src));
    }

    assert.equal(presentAt(src, '.claude/settings.json'), true);
    assert.equal(presentAt(src, '.mcp.json'), true);
    assert.equal(fs.lstatSync(path.join(src, '.codex')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(outside, 'SECRET'), 'utf8'), 'keep-me');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(skills, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('review-pr --check does not delete agent config from the real cwd', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-agent-check-'));
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-agent-check-skills-'));
  try {
    gitInit(src);
    fs.mkdirSync(path.join(src, '.claude'));
    fs.writeFileSync(path.join(src, '.claude', 'settings.json'), '{"hooks":{}}');
    fs.writeFileSync(path.join(src, '.mcp.json'), '{}');
    fs.writeFileSync(path.join(src, 'a'), 'a');
    commitAll(src, 'check');

    writeRelay(skills, 'ok', `
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(out + '/result.json', JSON.stringify({ status: 'completed',
  finalMessage: '\`\`\`json\\n{"schema": "debate-review/check", "ok": true}\\n\`\`\`' }));
`);

    const result = spawnSync('node', [SCRIPT, '--check', '--repo-dir', src, '--main', 'ok', '--debate', 'ok'], {
      encoding: 'utf8',
      env: { ...process.env, DELEGATE_SKILLS_DIR: skills },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(presentAt(src, '.claude/settings.json'), true);
    assert.equal(presentAt(src, '.mcp.json'), true);
    assert.match(result.stderr, /WARNING/i);
    assert.match(result.stderr, /\.claude|\.mcp\.json/);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(skills, { recursive: true, force: true });
  }
});
