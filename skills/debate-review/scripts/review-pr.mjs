#!/usr/bin/env node
// debate-review · review-pr.mjs
// Review a GitHub PR / GitLab MR with two implementers that debate, then post one review.
// Node built-ins only. Shells out to: git, gh | glab, and delegate-skills relays (read-only).
// It never commits, never edits the PR branch, never approves/requests-changes.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.resolve(HERE, '..');

const HELP = `debate-review · review-pr.mjs

Usage:
  node review-pr.mjs <pr-url | number> [options]

Options:
  --main <implementer>      Override main implementer (claude|codex|cursor|grok|opencode|pi). Default: lane.
  --debate <implementer>    Override debate implementer. Default: lane.
  --main-lane <name>        Lane for main (default: review).
  --debate-lane <name>      Lane for debate (default: debate).
  --contested post|drop     What to do with findings debate refuted but main kept (default: post).
  --min-confidence <0-1>    Drop main findings below this before debate (default: 0.5).
  --base <ref>              Base ref override (default: the PR's base sha from the forge).
  --repo-dir <dir>          Local clone to use (default: cwd if its origin matches, else a cache clone).
  --out-dir <dir>           Artifacts (default: ~/.cache/debate-review/<owner>__<repo>/<N>/<head>).
  --timeout <dur>           Per-implementer relay watchdog (default: 30m).
  --dry-run                 Print the review instead of posting.
  --force                   Post even if this head SHA already has a debate-review.
  --keep                    Keep the temporary worktree.
  --help

Exit codes: 0 posted/dry-run, 1 runtime failure, 2 usage, 3 head already reviewed (no --force).
`;

// ---------- args ----------
function parseArgs(argv) {
  const o = { contested: 'post', minConfidence: 0.5, mainLane: 'review', debateLane: 'debate', timeout: '30m' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) die(2, `missing value for ${a}`); return argv[++i]; };
    switch (a) {
      case '--help': case '-h': process.stdout.write(HELP); process.exit(0);
      case '--main': o.main = next(); break;
      case '--debate': o.debate = next(); break;
      case '--main-lane': o.mainLane = next(); break;
      case '--debate-lane': o.debateLane = next(); break;
      case '--contested': o.contested = next(); if (!['post', 'drop'].includes(o.contested)) die(2, '--contested post|drop'); break;
      case '--min-confidence': o.minConfidence = Number(next()); if (!(o.minConfidence >= 0 && o.minConfidence <= 1)) die(2, '--min-confidence 0..1'); break;
      case '--base': o.base = next(); break;
      case '--repo-dir': o.repoDir = next(); break;
      case '--out-dir': o.outDir = next(); break;
      case '--timeout': o.timeout = next(); break;
      case '--dry-run': o.dryRun = true; break;
      case '--force': o.force = true; break;
      case '--keep': o.keep = true; break;
      default: if (a.startsWith('--')) die(2, `unknown option ${a}`); rest.push(a);
    }
  }
  if (rest.length !== 1) die(2, HELP);
  o.target = rest[0];
  return o;
}

function die(code, msg) { process.stderr.write(`review-pr: ${msg}\n`); process.exit(code); }
function log(msg) { process.stderr.write(`[debate-review] ${msg}\n`); }

// ---------- shell ----------
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}\n${r.stderr}`);
  return r;
}
const out = (cmd, args, opts) => sh(cmd, args, opts).stdout.trim();
const json = (cmd, args, opts) => JSON.parse(out(cmd, args, opts));

// ---------- target ----------
export function parseTarget(target, originUrl) {
  let m = target.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/pull\/(\d+)/);
  if (m) return { host: 'github', origin: 'github.com', owner: m[1], repo: m[2], number: Number(m[3]) };
  m = target.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (m) { const segs = m[2].split('/'); return { host: 'gitlab', origin: m[1], owner: segs.slice(0, -1).join('/'), repo: segs.at(-1), number: Number(m[3]) }; }
  if (/^\d+$/.test(target)) {
    if (!originUrl) throw new Error('a bare number needs a git remote to resolve against');
    const o = parseOrigin(originUrl);
    if (!o) throw new Error(`cannot parse origin ${originUrl}`);
    return { ...o, number: Number(target) };
  }
  throw new Error(`unrecognised target ${target}`);
}
export function parseOrigin(url) {
  let m = url.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const host = m[1].toLowerCase(), segs = m[2].split('/');
  const kind = host === 'github.com' ? 'github' : 'gitlab';
  return { host: kind, origin: host, owner: segs.slice(0, -1).join('/'), repo: segs.at(-1) };
}
const projectPath = t => `${t.owner}/${t.repo}`;
const glabProject = t => encodeURIComponent(projectPath(t));

// ---------- forge ----------
function fetchPR(t) {
  if (t.host === 'github') {
    const p = json('gh', ['pr', 'view', String(t.number), '--repo', projectPath(t), '--json',
      'number,title,body,url,headRefOid,headRefName,baseRefName,isCrossRepository']);
    const baseSha = out('gh', ['api', `repos/${projectPath(t)}/pulls/${t.number}`, '-q', '.base.sha']);
    return { title: p.title, body: p.body || '', url: p.url, head: p.headRefOid, headRef: p.headRefName, baseRef: p.baseRefName, baseSha,
      fetchRef: `pull/${t.number}/head` };
  }
  const env = { ...process.env, GITLAB_HOST: t.origin };
  const mr = json('glab', ['api', `projects/${glabProject(t)}/merge_requests/${t.number}`], { env });
  return { title: mr.title, body: mr.description || '', url: mr.web_url, head: mr.diff_refs.head_sha, headRef: mr.source_branch,
    baseRef: mr.target_branch, baseSha: mr.diff_refs.base_sha, startSha: mr.diff_refs.start_sha, fetchRef: `merge-requests/${t.number}/head`, env };
}

function existingReview(t, pr) {
  const marker = `<!-- debate-review head=${pr.head}`;
  if (t.host === 'github') {
    const bodies = out('gh', ['api', `repos/${projectPath(t)}/pulls/${t.number}/reviews`, '--paginate', '-q', '.[].body']);
    return bodies.includes(marker);
  }
  const bodies = out('glab', ['api', `projects/${glabProject(t)}/merge_requests/${t.number}/notes?per_page=100`, '--paginate'], { env: pr.env });
  return bodies.includes(marker);
}

function fetchSpec(t, pr, commitsText) {
  const refs = [...new Set([...(pr.title + '\n' + pr.body + '\n' + commitsText).matchAll(/(?:^|[^\w/])#(\d+)\b/g)].map(m => m[1]))].slice(0, 2);
  const parts = [];
  for (const n of refs) {
    try {
      if (t.host === 'github') {
        const i = json('gh', ['issue', 'view', n, '--repo', projectPath(t), '--json', 'title,body,url']);
        parts.push(`Issue #${n} — ${i.title}\n${i.url}\n${i.body || ''}`);
      } else {
        const i = json('glab', ['api', `projects/${glabProject(t)}/issues/${n}`], { env: pr.env });
        parts.push(`Issue #${n} — ${i.title}\n${i.web_url}\n${i.description || ''}`);
      }
    } catch { /* not an issue ref; ignore */ }
  }
  return parts.length ? parts.join('\n\n---\n\n').slice(0, 8000) : 'none found — skip the Spec axis';
}

// ---------- repo / worktree ----------
function ensureClone(t, o) {
  const originOf = dir => { const r = sh('git', ['-C', dir, 'remote', 'get-url', 'origin'], { allowFail: true }); return r.status === 0 ? r.stdout.trim() : null; };
  const matches = dir => { const po = originOf(dir); const p = po && parseOrigin(po); return p && p.owner.toLowerCase() === t.owner.toLowerCase() && p.repo.toLowerCase() === t.repo.toLowerCase(); };
  if (o.repoDir) { if (!matches(o.repoDir)) throw new Error(`--repo-dir origin does not match ${projectPath(t)}`); return path.resolve(o.repoDir); }
  const top = sh('git', ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (top.status === 0 && matches(top.stdout.trim())) return top.stdout.trim();
  const cache = path.join(os.homedir(), '.cache', 'debate-review', 'clones', `${t.owner.replace(/\//g, '__')}__${t.repo}`);
  if (!fs.existsSync(cache)) {
    log(`cloning ${projectPath(t)} into ${cache}`);
    const url = t.host === 'github' ? `https://github.com/${projectPath(t)}.git` : `https://${t.origin}/${projectPath(t)}.git`;
    sh('git', ['clone', '--filter=blob:none', url, cache], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  return cache;
}

function makeWorktree(clone, pr, base, number) {
  sh('git', ['-C', clone, 'fetch', '--quiet', 'origin', pr.fetchRef, `${base}:refs/remotes/origin/${base}`], { allowFail: true });
  sh('git', ['-C', clone, 'fetch', '--quiet', 'origin', pr.fetchRef]);
  sh('git', ['-C', clone, 'fetch', '--quiet', 'origin', base]);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), `debate-review-${number}-`));
  fs.rmSync(wt, { recursive: true, force: true });
  sh('git', ['-C', clone, 'worktree', 'add', '--detach', '--quiet', wt, pr.head]);
  return wt;
}
function removeWorktree(clone, wt) { sh('git', ['-C', clone, 'worktree', 'remove', '--force', wt], { allowFail: true }); }

// ---------- diff map ----------
// Returns Map<path, Set<newSideLine>> for lines that appear in the unified diff (context + added).
export function diffLineMap(diffText) {
  const map = new Map(); let file = null; let ln = 0;
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) { file = null; continue; }
    if (raw.startsWith('+++ ')) { file = raw.slice(4).replace(/^b\//, ''); if (file === '/dev/null') file = null; else map.set(file, new Set()); continue; }
    if (raw.startsWith('--- ')) continue;
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) { ln = Number(h[1]); continue; }
    if (!file) continue;
    if (raw.startsWith('+') ) { map.get(file).add(ln++); continue; }
    if (raw.startsWith('-')) continue;
    if (raw.startsWith('\\')) continue;
    map.get(file).add(ln++);
  }
  return map;
}
// Snap a finding to a commentable (file, line[, start_line]); null if file not in diff.
export function anchor(map, f) {
  const lines = map.get(f.file); if (!lines || lines.size === 0) return null;
  const nearest = n => [...lines].reduce((b, x) => Math.abs(x - n) < Math.abs(b - n) ? x : b);
  const end = lines.has(f.line_end) ? f.line_end : nearest(f.line_end || f.line_start);
  let start = lines.has(f.line_start) ? f.line_start : end;
  if (start >= end) start = undefined;
  // multi-line needs every line in between to be in the same hunk; be conservative
  if (start !== undefined) for (let i = start; i <= end; i++) if (!lines.has(i)) { start = undefined; break; }
  return { path: f.file, line: end, start_line: start, snapped: end !== f.line_end };
}

// ---------- lanes / relays ----------
function findSkillsRoots() {
  const roots = [process.env.DELEGATE_SKILLS_DIR, path.join(os.homedir(), '.agents', 'skills'), path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.codex', 'skills')].filter(Boolean);
  return roots.filter(r => fs.existsSync(r));
}
function findScript(skill, script) {
  for (const r of findSkillsRoots()) { const p = path.join(r, skill, 'scripts', script); if (fs.existsSync(p)) return p; }
  throw new Error(`cannot find ${skill}/scripts/${script} under ${findSkillsRoots().join(', ') || '(no skills dir)'} — install delegate-skills`);
}
function resolveRole(role, o, cwd) {
  const explicit = role === 'main' ? o.main : o.debate;
  const lane = role === 'main' ? o.mainLane : o.debateLane;
  if (explicit) return { implementer: explicit, lane: null };
  const cfg = json('node', [findScript('delegate-setup', 'config.mjs'), 'load', '--cwd', cwd]);
  const l = cfg.lanes?.[lane];
  if (!l) throw new Error(`lane "${lane}" not configured — run delegate-setup or pass --${role} <implementer>`);
  return { implementer: l.implementer, lane };
}
const READ_ONLY = new Set(['claude', 'codex', 'cursor', 'grok', 'opencode', 'pi']);

function dispatch(role, who, brief, cwd, outDir, o) {
  if (!READ_ONLY.has(who.implementer)) throw new Error(`${who.implementer} relay has no --read-only; pick another ${role} implementer`);
  const relay = findScript(`${who.implementer}-delegate`, 'relay.mjs');
  const dir = path.join(outDir, role); fs.mkdirSync(dir, { recursive: true });
  const briefPath = path.join(dir, 'brief.md'); fs.writeFileSync(briefPath, brief);
  const args = [relay, '--brief', briefPath, '--cd', cwd, '--read-only', '--out-dir', dir, '--timeout', o.timeout];
  if (who.lane) args.push('--lane', who.lane);
  log(`${role}: ${who.implementer}${who.lane ? ` (lane ${who.lane})` : ''} …`);
  const t0 = Date.now();
  const r = spawnSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  const resPath = path.join(dir, 'result.json');
  if (!fs.existsSync(resPath)) throw new Error(`${role}: relay exited ${r.status} without result.json`);
  const res = JSON.parse(fs.readFileSync(resPath, 'utf8'));
  if (res.status !== 'completed') throw new Error(`${role}: relay status ${res.status}`);
  if (res.readOnlyViolation === true) log(`WARNING ${role}: relay reported a read-only violation — inspect ${dir}`);
  log(`${role}: done in ${Math.round((Date.now() - t0) / 1000)}s`);
  return { text: res.finalMessage || '', seconds: Math.round((Date.now() - t0) / 1000) };
}

export function extractJson(text) {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map(m => m[1]);
  const cands = blocks.length ? blocks.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of cands) { try { return JSON.parse(c); } catch { /* next */ } }
  throw new Error('implementer returned no parseable JSON block');
}
function expect(doc, schema, role) {
  if (!doc || doc.schema !== schema) throw new Error(`${role}: expected schema ${schema}, got ${doc && doc.schema}`);
  return doc;
}

// ---------- prompts ----------
function schemaSection(n) {
  const md = fs.readFileSync(path.join(SKILL, 'references', 'schema.md'), 'utf8');
  const parts = md.split(/^## /m); return '## ' + parts[n];
}
function fill(name, vars) {
  let t = fs.readFileSync(path.join(SKILL, 'prompts', name), 'utf8');
  for (const [k, v] of Object.entries(vars)) t = t.split(`{{${k}}}`).join(v);
  return t;
}
function findStandards(wt) {
  const cands = ['CONTRIBUTING.md', 'CODING_STANDARDS.md', 'CLAUDE.md', 'AGENTS.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/agents'];
  const found = [];
  for (const c of cands) { const p = path.join(wt, c); if (!fs.existsSync(p)) continue; if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) found.push(path.join(c, f)); else found.push(c); }
  return found.length ? found.join(', ') : 'none found — skip the Standards axis';
}

// ---------- render / post ----------
function renderBody(t, who, finalDoc, posted, unanchored) {
  const agreed = posted.filter(f => f.status === 'agreed').length, contested = posted.filter(f => f.status === 'contested').length;
  let b = `<!-- debate-review head=${finalDoc.head} main=${who.main.implementer} debate=${who.debate.implementer} agreed=${agreed} contested=${contested} -->\n`;
  b += `**debate-review** · main: \`${who.main.implementer}\` · debate: \`${who.debate.implementer}\` · ${agreed} agreed · ${contested} contested\n\n${finalDoc.summary || ''}\n`;
  if (unanchored.length) { b += `\n**Findings outside the diff** (could not be anchored inline):\n`; for (const f of unanchored) b += `\n- ${renderInline(f).replace(/^<!--.*-->\n/, '').replace(/\n+/g, ' ')}`; b += '\n'; }
  return b;
}
function renderInline(f) {
  return `<!-- debate-review:${f.id} status=${f.status} severity=${f.severity} -->\n` +
    `**${f.severity} · ${f.status}** — ${f.claim}\n\n${f.evidence || ''}\n\n` +
    (f.recommendation ? `Suggested: ${f.recommendation}\n\n` : '') + (f.debate_note ? `_${f.debate_note}_\n` : '');
}

function postGithub(t, pr, body, comments) {
  const payload = { commit_id: pr.head, event: 'COMMENT', body, comments: comments.map(c => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body, ...(c.start_line ? { start_line: c.start_line, start_side: 'RIGHT' } : {}) })) };
  const r = json('gh', ['api', '--method', 'POST', `repos/${projectPath(t)}/pulls/${t.number}/reviews`, '--input', '-'], { input: JSON.stringify(payload) });
  return { reviewId: r.id, url: r.html_url };
}
function postGitlab(t, pr, body, comments) {
  const base = `projects/${glabProject(t)}/merge_requests/${t.number}`;
  const ids = [];
  for (const c of comments) {
    const payload = { body: c.body, position: { position_type: 'text', base_sha: pr.baseSha, start_sha: pr.startSha, head_sha: pr.head, new_path: c.path, old_path: c.path, new_line: c.line } };
    const r = json('glab', ['api', '--method', 'POST', `${base}/discussions`, '--input', '-'], { input: JSON.stringify(payload), env: pr.env });
    ids.push(r.id);
  }
  const n = json('glab', ['api', '--method', 'POST', `${base}/notes`, '--input', '-'], { input: JSON.stringify({ body }), env: pr.env });
  return { noteId: n.id, discussionIds: ids, url: pr.url };
}

// ---------- main ----------
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const originNow = (() => { const r = sh('git', ['remote', 'get-url', 'origin'], { allowFail: true }); return r.status === 0 ? r.stdout.trim() : null; })();
  const t = parseTarget(o.target, originNow);
  const pr = fetchPR(t);
  log(`${projectPath(t)}#${t.number} @ ${pr.head.slice(0, 10)} (${pr.headRef} → ${pr.baseRef})`);

  if (!o.force && !o.dryRun && existingReview(t, pr)) { log('this head already has a debate-review; use --force'); process.exit(3); }

  const clone = ensureClone(t, o);
  const base = o.base || pr.baseRef;
  const wt = makeWorktree(clone, pr, base, t.number);
  const outDir = o.outDir || path.join(os.homedir(), '.cache', 'debate-review', `${t.owner.replace(/\//g, '__')}__${t.repo}`, String(t.number), pr.head.slice(0, 12));
  fs.mkdirSync(outDir, { recursive: true });
  const run = { schema: 'debate-review.run.v1', target: t, pr: { ...pr, env: undefined }, outDir, startedAt: new Date().toISOString(), stages: {} };
  const save = () => fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(run, null, 2));

  try {
    // Diff against the PR's own base sha (what the forge shows), not the branch tip: still works after merge.
    const baseRef = o.base || pr.baseSha;
    const diff = out('git', ['-C', wt, 'diff', `${baseRef}...HEAD`]);
    if (!diff.trim()) throw new Error('empty diff — nothing to review');
    const commits = out('git', ['-C', wt, 'log', `${baseRef}..HEAD`, '--oneline']);
    const lineMap = diffLineMap(diff);
    const who = { main: resolveRole('main', o, clone), debate: resolveRole('debate', o, clone) };
    run.who = who; save();

    const common = { BASE: baseRef, HEAD: pr.head, PR_TITLE: pr.title, PR_BODY: pr.body.slice(0, 6000) || '(empty)' };

    // 1. main
    const briefMain = fill('review-main.md', { ...common, SPEC: fetchSpec(t, pr, commits), STANDARDS: findStandards(wt), SCHEMA_FINDINGS: schemaSection(1) });
    const m = dispatch('main', who.main, briefMain, wt, outDir, o);
    const findings = expect(extractJson(m.text), 'debate-review.findings.v1', 'main');
    findings.findings = (findings.findings || []).filter(f => (f.confidence ?? 1) >= o.minConfidence);
    run.stages.main = { seconds: m.seconds, doc: findings }; save();
    log(`main: ${findings.findings.length} findings after confidence filter`);

    // 2. debate
    const briefDebate = fill('review-debate.md', { ...common, FINDINGS_JSON: JSON.stringify(findings, null, 2), SCHEMA_DEBATE: schemaSection(2) });
    const d = dispatch('debate', who.debate, briefDebate, wt, outDir, o);
    const debate = expect(extractJson(d.text), 'debate-review.debate.v1', 'debate');
    run.stages.debate = { seconds: d.seconds, doc: debate }; save();
    log(`debate: ${(debate.verdicts || []).length} verdicts, ${(debate.new_findings || []).length} new findings`);

    // 3. rebuttal (skip the round-trip when there is nothing to argue about)
    let finalDoc;
    const nothingToDebate = findings.findings.length === 0 && (debate.new_findings || []).length === 0;
    if (nothingToDebate) {
      finalDoc = { schema: 'debate-review.final.v1', head: pr.head, summary: findings.summary || 'No material findings from either reviewer.', findings: [] };
    } else {
      const briefFinal = fill('review-rebuttal.md', { ...common, FINDINGS_JSON: JSON.stringify(findings, null, 2), DEBATE_JSON: JSON.stringify(debate, null, 2), SCHEMA_FINAL: schemaSection(3) });
      const f = dispatch('final', who.main, briefFinal, wt, outDir, o);
      finalDoc = expect(extractJson(f.text), 'debate-review.final.v1', 'final');
      run.stages.final = { seconds: f.seconds, doc: finalDoc };
    }
    finalDoc.head = pr.head; save();

    // 4. select + anchor
    const keep = (finalDoc.findings || []).filter(f => f.status === 'agreed' || (f.status === 'contested' && o.contested === 'post'));
    const comments = [], unanchored = [];
    for (const f of keep) {
      const a = anchor(lineMap, f);
      if (!a) { unanchored.push(f); continue; }
      comments.push({ ...a, body: renderInline(f) + (a.snapped ? `\n_(anchored to nearest diff line; original ${f.line_start}-${f.line_end})_\n` : '') });
    }
    const body = renderBody(t, who, finalDoc, keep, unanchored);
    run.posted = { body, comments, withdrawn: (finalDoc.findings || []).filter(f => f.status === 'withdrawn').map(f => f.id) }; save();

    // 5. post / print
    if (o.dryRun) {
      process.stdout.write(`\n===== REVIEW BODY =====\n${body}\n`);
      for (const c of comments) process.stdout.write(`\n===== ${c.path}:${c.start_line ? c.start_line + '-' : ''}${c.line} =====\n${c.body}\n`);
      process.stdout.write(`\n(dry-run: nothing posted; artifacts in ${outDir})\n`);
    } else {
      const r = t.host === 'github' ? postGithub(t, pr, body, comments) : postGitlab(t, pr, body, comments);
      run.postResult = r; save();
      log(`posted ${comments.length} inline comment(s): ${r.url}`);
      process.stdout.write(`${r.url}\n`);
    }
  } finally {
    if (!o.keep) removeWorktree(clone, wt);
    run.finishedAt = new Date().toISOString(); save();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { process.stderr.write(`review-pr: ${e.message}\n`); process.exit(1); });
}
