#!/usr/bin/env node
// debate-review · review-pr.mjs
//
// Review a GitHub PR / GitLab MR with two implementers that debate, then post one review.
//
//   1. main reviewer   → findings
//   2. debate reviewer → confirm / refute / downgrade each finding, add its own
//   3. main reviewer   → final call (agreed / contested / withdrawn)
//   4. post one review with inline comments (or print it with --dry-run)
//
// Shells out to git, gh|glab, and delegate-skills relays in --read-only. Never commits, never
// edits the PR branch, never approves or requests changes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, text, log } from './lib/shell.mjs';
import { parseTarget, parseOrigin, projectPath, fetchPR, alreadyReviewed, fetchSpec, postReview } from './lib/forge.mjs';
import { diffLineMap, anchor } from './lib/diff.mjs';
import { resolveRole, dispatch, extractJson } from './lib/dispatch.mjs';
import { validateFindings, validateDebate, validateFinal } from './lib/validate.mjs';
import { renderInline, renderBody } from './lib/render.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `debate-review · review-pr.mjs

Usage:
  node review-pr.mjs <pr-url | number> [options]

Options:
  --main <implementer>      Main reviewer (claude|codex|cursor|grok|opencode|pi…). Default: the lane.
  --debate <implementer>    Debate reviewer. Default: the lane.
  --main-lane <name>        Fleet lane for main (default: review-main).
  --debate-lane <name>      Fleet lane for debate (default: review-debate).
  --contested post|drop     Findings debate refuted but main kept (default: post, tagged).
  --min-confidence <0-1>    Drop findings (main F* and debate D*) below this confidence (default: 0.5).
  --base <ref>              Base override (default: the PR's base sha from the forge).
  --repo-dir <dir>          Local clone to use (default: cwd if its origin matches, else a cache clone).
  --out-dir <dir>           Artifacts (default: ~/.cache/debate-review/<owner>__<repo>/<N>/<head>).
  --timeout <dur>           Per-implementer relay watchdog (default: 30m).
  --dry-run                 Print the review instead of posting.
  --force                   Post even if this head sha already has a debate-review.
  --keep                    Keep the temporary worktree.
  --help

Exit codes: 0 posted/dry-run · 1 failure · 2 usage · 3 head already reviewed (use --force)
`;

// ============================================================ args

function parseArgs(argv) {
  const opts = {
    mainLane: 'review-main',
    debateLane: 'review-debate',
    contested: 'post',
    minConfidence: 0.5,
    timeout: '30m',
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(2, `missing value for ${arg}`);
      return argv[++i];
    };

    if (arg === '--help' || arg === '-h') { process.stdout.write(HELP); process.exit(0); }
    else if (arg === '--main') opts.main = value();
    else if (arg === '--debate') opts.debate = value();
    else if (arg === '--main-lane') opts.mainLane = value();
    else if (arg === '--debate-lane') opts.debateLane = value();
    else if (arg === '--contested') opts.contested = value();
    else if (arg === '--min-confidence') opts.minConfidence = Number(value());
    else if (arg === '--base') opts.base = value();
    else if (arg === '--repo-dir') opts.repoDir = value();
    else if (arg === '--out-dir') opts.outDir = value();
    else if (arg === '--timeout') opts.timeout = value();
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg.startsWith('--')) fail(2, `unknown option ${arg}`);
    else positional.push(arg);
  }

  if (positional.length !== 1) fail(2, HELP);
  if (!['post', 'drop'].includes(opts.contested)) fail(2, '--contested must be post or drop');
  if (!(opts.minConfidence >= 0 && opts.minConfidence <= 1)) fail(2, '--min-confidence must be 0..1');

  opts.target = positional[0];
  return opts;
}

function fail(code, message) {
  process.stderr.write(`review-pr: ${message}\n`);
  process.exit(code);
}

// ============================================================ local checkout

function currentOrigin() {
  const r = run('git', ['remote', 'get-url', 'origin'], { allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function cloneMatches(dir, target) {
  const r = run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { allowFail: true });
  if (r.status !== 0) return false;
  const origin = parseOrigin(r.stdout.trim());
  return origin
    && origin.owner.toLowerCase() === target.owner.toLowerCase()
    && origin.repo.toLowerCase() === target.repo.toLowerCase();
}

/** Find a local clone of the PR's repo: --repo-dir, else cwd, else a cache clone. */
function findClone(target, opts) {
  if (opts.repoDir) {
    if (!cloneMatches(opts.repoDir, target)) throw new Error(`--repo-dir origin does not match ${projectPath(target)}`);
    return path.resolve(opts.repoDir);
  }

  const top = run('git', ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (top.status === 0 && cloneMatches(top.stdout.trim(), target)) return top.stdout.trim();

  const cache = path.join(os.homedir(), '.cache', 'debate-review', 'clones', `${target.owner.replace(/\//g, '__')}__${target.repo}`);
  if (!fs.existsSync(cache)) {
    log(`cloning ${projectPath(target)} into ${cache}`);
    const url = `https://${target.origin}/${projectPath(target)}.git`;
    run('git', ['clone', '--filter=blob:none', url, cache], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  return cache;
}

/** Fetch the PR head + base and check the head out in a throwaway worktree. */
function makeWorktree(clone, pr, baseBranch) {
  run('git', ['-C', clone, 'fetch', '--quiet', 'origin', pr.fetchRef]);
  run('git', ['-C', clone, 'fetch', '--quiet', 'origin', baseBranch]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-review-'));
  fs.rmSync(dir, { recursive: true, force: true }); // git wants to create it
  run('git', ['-C', clone, 'worktree', 'add', '--detach', '--quiet', dir, pr.head]);
  return dir;
}

function removeWorktree(clone, dir) {
  run('git', ['-C', clone, 'worktree', 'remove', '--force', dir], { allowFail: true });
}

// ============================================================ briefs

function prompt(name, vars) {
  let body = fs.readFileSync(path.join(SKILL_DIR, 'assets', 'prompts', name), 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    body = body.split(`{{${key}}}`).join(value);
  }
  return body;
}

/** Section n of references/schema.md ("## 1.", "## 2.", "## 3."), the schema text the implementer sees. */
function schemaSection(n) {
  const md = fs.readFileSync(path.join(SKILL_DIR, 'references', 'schema.md'), 'utf8');
  return '## ' + md.split(/^## /m)[n];
}

/** Files that document how code should be written in this repo (the Standards axis). */
function findStandards(worktree) {
  const candidates = ['CONTRIBUTING.md', 'CODING_STANDARDS.md', 'CLAUDE.md', 'AGENTS.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/agents'];
  const found = [];
  for (const rel of candidates) {
    const abs = path.join(worktree, rel);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs)) found.push(path.join(rel, f));
    } else {
      found.push(rel);
    }
  }
  return found.length ? found.join(', ') : 'none found, skip the Standards axis';
}

// ============================================================ flow

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // --- what are we reviewing?
  const target = parseTarget(opts.target, currentOrigin());
  const pr = fetchPR(target);
  log(`${projectPath(target)}#${target.number} @ ${pr.head.slice(0, 10)} (${pr.headRef} → ${pr.baseRef})`);

  if (!opts.force && !opts.dryRun && alreadyReviewed(target, pr)) {
    log('this head already has a debate-review; use --force to post another');
    process.exit(3);
  }

  // --- check it out
  const clone = findClone(target, opts);
  const worktree = makeWorktree(clone, pr, pr.baseRef);
  const baseRef = opts.base || pr.baseSha; // the forge's own base sha: still valid after merge

  const outDir = opts.outDir || path.join(os.homedir(), '.cache', 'debate-review',
    `${target.owner.replace(/\//g, '__')}__${target.repo}`, String(target.number), pr.head.slice(0, 12));
  fs.mkdirSync(outDir, { recursive: true });

  const runLog = { schema: 'debate-review.run.v1', target, pr, outDir, startedAt: new Date().toISOString(), stages: {} };
  const save = () => fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(runLog, null, 2));

  try {
    const diff = text('git', ['-C', worktree, 'diff', `${baseRef}...HEAD`]);
    if (!diff.trim()) throw new Error('empty diff, nothing to review');
    const commits = text('git', ['-C', worktree, 'log', `${baseRef}..HEAD`, '--oneline']);
    const lineMap = diffLineMap(diff);

    const who = {
      main: resolveRole('main', { explicit: opts.main, lane: opts.mainLane, cwd: clone }),
      debate: resolveRole('debate', { explicit: opts.debate, lane: opts.debateLane, cwd: clone }),
    };
    runLog.who = who;
    save();

    const common = {
      BASE: baseRef,
      HEAD: pr.head,
      PR_TITLE: pr.title,
      PR_BODY: pr.body.slice(0, 6000) || '(empty)',
    };
    const send = (role, implementer, brief) => dispatch({ role, who: implementer, brief, cwd: worktree, outDir, timeout: opts.timeout });

    // --- 1. main review
    const mainBrief = prompt('review-main.md', {
      ...common,
      SPEC: fetchSpec(target, pr, commits),
      STANDARDS: findStandards(worktree),
      SCHEMA_FINDINGS: schemaSection(1),
    });
    const mainRun = send('main', who.main, mainBrief);
    const findings = validateFindings(extractJson(mainRun.text));
    findings.findings = findings.findings.filter(f => (f.confidence ?? 1) >= opts.minConfidence);
    runLog.stages.main = { seconds: mainRun.seconds, doc: findings };
    save();
    log(`main: ${findings.findings.length} finding(s) after the confidence filter`);

    // --- 2. debate
    const debateBrief = prompt('review-debate.md', {
      ...common,
      FINDINGS_JSON: JSON.stringify(findings, null, 2),
      SCHEMA_DEBATE: schemaSection(2),
    });
    const debateRun = send('debate', who.debate, debateBrief);
    const debate = validateDebate(extractJson(debateRun.text), findings);
    debate.new_findings = debate.new_findings.filter(f => (f.confidence ?? 1) >= opts.minConfidence);
    runLog.stages.debate = { seconds: debateRun.seconds, doc: debate };
    save();
    log(`debate: ${debate.verdicts.length} verdict(s), ${debate.new_findings.length} new finding(s) after the confidence filter`);

    // --- 3. final call (skipped when there is nothing to argue about)
    let finalDoc;
    const nothingToDebate = findings.findings.length === 0 && debate.new_findings.length === 0;
    if (nothingToDebate) {
      finalDoc = {
        schema: 'debate-review.final.v1',
        head: pr.head,
        summary: findings.summary || 'No material findings from either reviewer.',
        findings: [],
      };
    } else {
      const finalBrief = prompt('review-rebuttal.md', {
        ...common,
        FINDINGS_JSON: JSON.stringify(findings, null, 2),
        DEBATE_JSON: JSON.stringify(debate, null, 2),
        SCHEMA_FINAL: schemaSection(3),
      });
      const finalRun = send('final', who.main, finalBrief);
      finalDoc = validateFinal(extractJson(finalRun.text), findings, debate);
      runLog.stages.final = { seconds: finalRun.seconds, doc: finalDoc };
    }
    finalDoc.head = pr.head;
    const axisOf = new Map([...findings.findings, ...debate.new_findings].map(f => [f.id, f.axis]));
    for (const f of finalDoc.findings || []) if (!f.axis) f.axis = axisOf.get(f.id);
    save();

    // --- 4. choose what to post and anchor it to the diff
    const toPost = (finalDoc.findings || []).filter(f =>
      f.status === 'agreed' || (f.status === 'contested' && opts.contested === 'post'));

    const comments = [];
    const unanchored = [];
    for (const f of toPost) {
      const a = anchor(lineMap, f);
      if (!a) { unanchored.push(f); continue; }
      let body = renderInline(f);
      if (a.snapped) body += `\n_(anchored to the nearest diff line; the finding named ${f.line_start}-${f.line_end})_\n`;
      comments.push({ ...a, body });
    }
    const body = renderBody({ who, finalDoc, posted: toPost, unanchored });

    runLog.posted = {
      body,
      comments,
      withdrawn: (finalDoc.findings || []).filter(f => f.status === 'withdrawn').map(f => f.id),
    };
    save();

    // --- 5. post or print
    if (opts.dryRun) {
      process.stdout.write(`\n===== REVIEW BODY =====\n${body}\n`);
      for (const c of comments) {
        const range = c.start_line ? `${c.start_line}-${c.line}` : String(c.line);
        process.stdout.write(`\n===== ${c.path}:${range} =====\n${c.body}\n`);
      }
      process.stdout.write(`\n(dry-run: nothing posted; artifacts in ${outDir})\n`);
    } else {
      const result = postReview(target, pr, body, comments);
      runLog.postResult = result;
      save();
      log(`posted ${comments.length} inline comment(s): ${result.url}`);
      process.stdout.write(`${result.url}\n`);
    }
  } finally {
    if (!opts.keep) removeWorktree(clone, worktree);
    runLog.finishedAt = new Date().toISOString();
    save();
  }
}

main().catch(error => {
  process.stderr.write(`review-pr: ${error.message}\n`);
  process.exit(1);
});
