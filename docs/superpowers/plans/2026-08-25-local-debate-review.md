# Local debate-review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--local` so `review-pr.mjs` can run the three-pass debate against a working-tree snapshot with no GitHub/GitLab.

**Architecture:** New `lib/local.mjs` snapshots disk into a throwaway `git clone --local` (prune-before-copy overlay, isolated clone-side git). `review-pr.mjs` branches only at source resolution, role cwd vs relay cwd, and print-vs-post. The brief/dispatch/validate/render path stays shared.

**Tech Stack:** Node 18+ (CI is 22), Node test runner (`node --test`), `git` 2.x, existing `shell.mjs` `spawnSync` wrappers. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-local-debate-review-design.md`

## Global Constraints

- One script: do not add `local-review.mjs` or a second binary.
- `--local` and `--dry-run` do not combine; `--local` never takes a PR URL.
- Orchestrator never calls `fetchPR`, `alreadyReviewed`, `fetchSpec`, or `postReview` on the local path. Do not invent a forge `target` (`forge.mjs` treats every non-GitHub host as GitLab).
- Relays stay `--read-only` with the ambient environment. Local mode does not add a network deny.
- User index, HEAD, refs, and worktrees are never written. Snapshot objects live only in the temp clone.
- Discovery git (`status`, `ls-files`, `rev-parse` in `repoDir`) uses the user's config. Clone-side git is isolated (`GIT_CONFIG_GLOBAL`/`SYSTEM` empty, empty `core.hooksPath`, `commit.gpgSign=false`, `commit --no-verify`).
- Disk wins except gitlinks (mode `160000`), which stay at user HEAD.
- Tests: spawn `review-pr.mjs`; do not `import` it (`main()` runs on import). No live relays, no network. Do not spawn bare `--local` without `--repo-dir` pointing at a fixture (cwd is this repo and would start a real debate).
- Gate: `node --test test/*.test.mjs`

## File map

| File | Responsibility |
| --- | --- |
| `skills/debate-review/scripts/lib/local.mjs` | `resolveBase`, `isClean`, `hasUnmerged`, `hasHiddenIndexBits`, `snapshotWorkingTree` |
| `skills/debate-review/scripts/review-pr.mjs` | `--local` parsing; local source + print; `resolveRole` from `repoDir`; relays in the snapshot |
| `test/review-pr.test.mjs` | Spawn usage tests |
| `test/local.test.mjs` | Fixture-repo tests for `local.mjs` |
| `skills/debate-review/SKILL.md` | Agent: no PR URL → `--local` |
| `README.md` | "Local preview" section |

---

### Task 1: `--local` usage parsing

**Files:**
- Modify: `skills/debate-review/scripts/review-pr.mjs` (`HELP`, `parseArgs`)
- Test: `test/review-pr.test.mjs`

**Interfaces:**
- Consumes: existing `parseArgs` (not exported), `fail(code, message)`, spawn tests already in `test/review-pr.test.mjs`
- Produces: `opts.local === true` with no `opts.target` when `--local` is set and there is no positional; `opts.dryRun` unchanged; illegal combinations `process.exit(2)` with stderr that names `--local`

- [ ] **Step 1: Write the failing usage tests**

Add to `test/review-pr.test.mjs` after the existing `review-pr: usage errors exit 2` test:

```javascript
test('review-pr: --local and --dry-run are separate jobs', () => {
  const script = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
  const spawn = (args) => spawnSync('node', [script, ...args], { encoding: 'utf8' });

  const both = spawn(['--local', '--dry-run']);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /--local/);

  const localWithUrl = spawn(['--local', 'https://github.com/a/b/pull/1']);
  assert.equal(localWithUrl.status, 2);
  assert.match(localWithUrl.stderr, /--local/);

  const dryNoUrl = spawn(['--dry-run']);
  assert.equal(dryNoUrl.status, 2);
  assert.match(dryNoUrl.stderr, /--local/);
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `node --test test/review-pr.test.mjs`

Expected: `review-pr: --local and --dry-run are separate jobs` FAIL. Today `--local` is `unknown option` (still exit 2, but `--dry-run` with no URL prints `HELP` and does not name `--local`).

- [ ] **Step 3: Implement parsing and help**

In `skills/debate-review/scripts/review-pr.mjs`, replace `HELP` with:

```javascript
const HELP = `debate-review · review-pr.mjs

Usage:
  node review-pr.mjs --local [--base <ref>] [--repo-dir <dir>] [options]
  node review-pr.mjs <pr-url | number> [--dry-run] [options]

Options:
  --local                   Review the working tree. No GitHub/GitLab. Prints the review.
  --main <implementer>      Main reviewer (claude|codex|cursor|grok|opencode|pi…). Default: the lane.
  --debate <implementer>    Debate reviewer. Default: the lane.
  --main-lane <name>        Fleet lane for main (default: review-main).
  --debate-lane <name>      Fleet lane for debate (default: review-debate).
  --contested post|drop     Findings debate refuted but main kept (default: post, tagged).
  --min-confidence <0-1>    Drop findings (main F* and debate D*) below this confidence (default: 0.5).
  --base <ref>              Base override (PR: forge base sha; --local: origin/HEAD, else main, else master).
  --repo-dir <dir>          Local clone (PR) or the working tree to snapshot (--local). Default: cwd.
  --out-dir <dir>           Artifacts (default: ~/.cache/debate-review/… ).
  --timeout <dur>           Per-implementer relay watchdog (default: 30m).
  --dry-run                 Print a live PR review instead of posting. Does not combine with --local.
  --force                   Post even if this head sha already has a debate-review.
  --keep                    Keep the temporary worktree (PR) or snapshot clone (--local).
  --help

Exit codes: 0 posted/printed · 1 failure · 2 usage · 3 head already reviewed (use --force)
`;
```

In `parseArgs`, add `else if (arg === '--local') opts.local = true;` next to `--dry-run`.

Replace the positional check at the end of `parseArgs` with:

```javascript
  if (opts.local && opts.dryRun) {
    fail(2, '--local and --dry-run do not combine; --local prints a working tree, --dry-run prints a live PR');
  }
  if (opts.local && positional.length !== 0) {
    fail(2, '--local does not take a PR URL; drop the URL or use --dry-run');
  }
  if (!opts.local && opts.dryRun && positional.length !== 1) {
    fail(2, '--dry-run needs a PR URL; for a working tree use --local');
  }
  if (!opts.local && positional.length !== 1) fail(2, HELP);
  if (!['post', 'drop'].includes(opts.contested)) fail(2, '--contested must be post or drop');
  if (!(opts.minConfidence >= 0 && opts.minConfidence <= 1)) fail(2, '--min-confidence must be 0..1');

  if (!opts.local) opts.target = positional[0];
  return opts;
```

Do not change `main()` yet. `--local` without a URL will still crash in `parseTarget` if someone runs it by hand; Task 3 wires the local path.

- [ ] **Step 4: Run tests**

Run: `node --test test/review-pr.test.mjs`

Expected: all tests PASS, including the new usage test and the existing `node [script]` (no args) exit 2 test.

- [ ] **Step 5: Commit**

```bash
git add skills/debate-review/scripts/review-pr.mjs test/review-pr.test.mjs
git commit -m "$(cat <<'EOF'
debate-review: --local is not --dry-run (usage only)

EOF
)"
```

---

### Task 2: `local.mjs` snapshot

**Files:**
- Create: `skills/debate-review/scripts/lib/local.mjs`
- Create: `test/local.test.mjs`

**Interfaces:**
- Consumes: `run`, `text`, `log` from `skills/debate-review/scripts/lib/shell.mjs`
- Produces:
  - `resolveBase(repoDir, override) → { name: string, sha: string }`
  - `isClean(repoDir) → boolean`
  - `hasUnmerged(repoDir) → boolean`
  - `hasHiddenIndexBits(repoDir) → boolean`
  - `snapshotWorkingTree(repoDir, { keep, base }) → { dir: string, pr: object, cleanup: () => void }`
  - `pr` shape: `{ title, body, url: '', head, headRef, baseRef, baseSha, fetchRef: null, local: true }`
  - `cleanup()` deletes `dir` unless `keep` was true
  - On throw after the clone exists, the function deletes `dir` itself (unless `keep`)

- [ ] **Step 1: Write `test/local.test.mjs` (all fixture cases)**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, text } from '../skills/debate-review/scripts/lib/shell.mjs';
import {
  resolveBase,
  isClean,
  hasUnmerged,
  hasHiddenIndexBits,
  snapshotWorkingTree,
} from '../skills/debate-review/scripts/lib/local.mjs';

function gitInit(dir, branch = 'main') {
  fs.mkdirSync(dir, { recursive: true });
  run('git', ['init', '-b', branch, dir]);
  run('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  run('git', ['-C', dir, 'config', 'user.name', 'Test']);
  run('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
}

function commitAll(dir, message) {
  run('git', ['-C', dir, 'add', '-A']);
  run('git', ['-C', dir, 'commit', '-m', message]);
}

function withRepo(fn, branch = 'main') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-local-src-'));
  gitInit(dir, branch);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveBase: --base wins, else origin/HEAD, else main, else master, else throw', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    const head = text('git', ['-C', dir, 'rev-parse', 'HEAD']);

    assert.equal(resolveBase(dir, head).sha, head);
    assert.equal(resolveBase(dir, 'HEAD').sha, head);
    assert.equal(resolveBase(dir).name, 'main');
    assert.equal(resolveBase(dir).sha, head);
  });

  const masterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-local-master-'));
  try {
    gitInit(masterDir, 'master');
    fs.writeFileSync(path.join(masterDir, 'a'), 'a');
    commitAll(masterDir, 'a');
    assert.equal(resolveBase(masterDir).name, 'master');
  } finally {
    fs.rmSync(masterDir, { recursive: true, force: true });
  }

  const developDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-local-dev-'));
  try {
    gitInit(developDir, 'develop');
    fs.writeFileSync(path.join(developDir, 'a'), 'a');
    commitAll(developDir, 'a');
    assert.throws(() => resolveBase(developDir), /cannot resolve a base branch; pass --base/);
  } finally {
    fs.rmSync(developDir, { recursive: true, force: true });
  }

  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    const mainSha = text('git', ['-C', dir, 'rev-parse', 'HEAD']);
    run('git', ['-C', dir, 'checkout', '-b', 'topic']);
    fs.writeFileSync(path.join(dir, 'b'), 'b');
    commitAll(dir, 'b');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-local-bare-'));
    fs.rmSync(bare, { recursive: true, force: true });
    run('git', ['clone', '--bare', dir, bare]);
    run('git', ['-C', dir, 'remote', 'add', 'origin', bare]);
    run('git', ['-C', dir, 'fetch', 'origin']);
    run('git', ['-C', dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    const resolved = resolveBase(dir);
    assert.equal(resolved.name, 'origin/main');
    assert.equal(resolved.sha, mainSha);
    fs.rmSync(bare, { recursive: true, force: true });
  });
});

test('hasUnmerged / hasHiddenIndexBits / isClean', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    assert.equal(isClean(dir), true);
    assert.equal(hasUnmerged(dir), false);
    assert.equal(hasHiddenIndexBits(dir), false);

    fs.writeFileSync(path.join(dir, 'a'), 'dirty');
    assert.equal(isClean(dir), false);

    fs.writeFileSync(path.join(dir, 'a'), 'a');
    run('git', ['-C', dir, 'update-index', '--assume-unchanged', 'a']);
    fs.writeFileSync(path.join(dir, 'a'), 'hidden');
    assert.equal(hasHiddenIndexBits(dir), true);
    run('git', ['-C', dir, 'update-index', '--no-assume-unchanged', 'a']);
    fs.writeFileSync(path.join(dir, 'a'), 'a');

    run('git', ['-C', dir, 'update-index', '--skip-worktree', 'a']);
    assert.equal(hasHiddenIndexBits(dir), true);
    run('git', ['-C', dir, 'update-index', '--no-skip-worktree', 'a']);
  });
});

test('snapshot: fast path on a clean feature branch', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    const mainSha = text('git', ['-C', dir, 'rev-parse', 'HEAD']);
    run('git', ['-C', dir, 'checkout', '-b', 'topic']);
    fs.writeFileSync(path.join(dir, 'b'), 'b');
    commitAll(dir, 'b');
    const head = text('git', ['-C', dir, 'rev-parse', 'HEAD']);

    const snap = snapshotWorkingTree(dir, { keep: false, base: 'main' });
    try {
      assert.equal(text('git', ['-C', snap.dir, 'rev-parse', 'HEAD']), head);
      assert.match(text('git', ['-C', snap.dir, 'diff', `${mainSha}...HEAD`]), /^diff --git a\/b b\/b/m);
      assert.equal(snap.pr.local, true);
      assert.equal(snap.pr.head, head);
      assert.equal(snap.pr.baseSha, mainSha);
      assert.doesNotMatch(snap.pr.body, /Snapshot includes uncommitted/);
      assert.equal(text('git', ['-C', dir, 'rev-parse', 'HEAD']), head);
      assert.equal(isClean(dir), true);
    } finally {
      snap.cleanup();
    }
    assert.equal(fs.existsSync(snap.dir), false);
  });
});

test('snapshot overlay: modified, deleted, git rm, untracked, gitignored', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(dir, 'edit.txt'), 'old');
    fs.writeFileSync(path.join(dir, 'drop.txt'), 'drop');
    fs.writeFileSync(path.join(dir, 'rm.txt'), 'rm');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
    commitAll(dir, 'base');
    const baseSha = text('git', ['-C', dir, 'rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(dir, 'edit.txt'), 'new');
    fs.unlinkSync(path.join(dir, 'drop.txt'));
    run('git', ['-C', dir, 'rm', 'rm.txt']);
    fs.writeFileSync(path.join(dir, 'fresh.txt'), 'fresh');
    fs.writeFileSync(path.join(dir, 'ignored.txt'), 'no');

    const snap = snapshotWorkingTree(dir, { keep: false, base: baseSha });
    try {
      const tree = text('git', ['-C', snap.dir, 'ls-tree', '-r', '--name-only', 'HEAD']);
      assert.match(tree, /^keep\.txt$/m);
      assert.match(tree, /^edit\.txt$/m);
      assert.doesNotMatch(tree, /^drop\.txt$/m);
      assert.doesNotMatch(tree, /^rm\.txt$/m);
      assert.match(tree, /^fresh\.txt$/m);
      assert.doesNotMatch(tree, /^ignored\.txt$/m);
      assert.equal(fs.readFileSync(path.join(snap.dir, 'edit.txt'), 'utf8'), 'new');
      assert.match(snap.pr.body, /Snapshot includes uncommitted/);
      assert.notEqual(snap.pr.head, baseSha);
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: symlink at HEAD replaced by a directory does not escape the clone', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-local-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'sentinel'), 'outside');
    withRepo((dir) => {
      fs.symlinkSync(outside, path.join(dir, 'link'));
      commitAll(dir, 'symlink');

      fs.unlinkSync(path.join(dir, 'link'));
      fs.mkdirSync(path.join(dir, 'link'));
      fs.writeFileSync(path.join(dir, 'link', 'inner.txt'), 'inner');

      const snap = snapshotWorkingTree(dir, { keep: false });
      try {
        assert.equal(fs.readFileSync(path.join(snap.dir, 'link', 'inner.txt'), 'utf8'), 'inner');
        assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'outside');
        assert.equal(fs.existsSync(path.join(outside, 'inner.txt')), false);
      } finally {
        snap.cleanup();
      }
    });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('snapshot overlay: mode-only +x is in the snapshot tree', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'tool.sh'), '#!/bin/sh\n');
    commitAll(dir, 'mode');
    fs.chmodSync(path.join(dir, 'tool.sh'), 0o755);

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      const stage = text('git', ['-C', snap.dir, 'ls-files', '-s', 'tool.sh']);
      assert.match(stage, /^100755 /);
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: gitlinks stay at user HEAD', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    const sha = text('git', ['-C', dir, 'rev-parse', 'HEAD']);
    run('git', ['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${sha},vendor/dep`]);
    run('git', ['-C', dir, 'commit', '-m', 'gitlink']);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'd');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      const stage = text('git', ['-C', snap.dir, 'ls-files', '-s', 'vendor/dep']);
      assert.match(stage, /^160000 /);
      assert.match(text('git', ['-C', snap.dir, 'ls-tree', '-r', '--name-only', 'HEAD']), /^dirty\.txt$/m);
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot refuses conflicted and hidden-bit worktrees', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    run('git', ['-C', dir, 'checkout', '-b', 'other']);
    fs.writeFileSync(path.join(dir, 'a'), 'other');
    commitAll(dir, 'other');
    run('git', ['-C', dir, 'checkout', 'main']);
    fs.writeFileSync(path.join(dir, 'a'), 'main2');
    commitAll(dir, 'main2');
    const merge = run('git', ['-C', dir, 'merge', 'other'], { allowFail: true });
    assert.notEqual(merge.status, 0);
    assert.equal(hasUnmerged(dir), true);
    assert.throws(() => snapshotWorkingTree(dir, { keep: false }), /conflicted working tree/);
  });

  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    run('git', ['-C', dir, 'update-index', '--skip-worktree', 'a']);
    assert.throws(() => snapshotWorkingTree(dir, { keep: false }), /skip-worktree|assume-unchanged/);
  });
});

test('snapshot cleanup removes the clone after success and after overlay failure', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    fs.writeFileSync(path.join(dir, 'b'), 'b');
    const snap = snapshotWorkingTree(dir, { keep: false });
    const kept = snap.dir;
    snap.cleanup();
    assert.equal(fs.existsSync(kept), false);

    const fifo = path.join(dir, 'pipe');
    run('mkfifo', [fifo]);
    assert.throws(() => snapshotWorkingTree(dir, { keep: false }), /special file/);
  });
});

test('snapshot does not change the user HEAD, index, or worktree list', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    fs.writeFileSync(path.join(dir, 'a'), 'dirty');
    const head = text('git', ['-C', dir, 'rev-parse', 'HEAD']);
    const index = fs.readFileSync(path.join(dir, '.git', 'index'));
    const trees = text('git', ['-C', dir, 'worktree', 'list']);

    const snap = snapshotWorkingTree(dir, { keep: false });
    snap.cleanup();

    assert.equal(text('git', ['-C', dir, 'rev-parse', 'HEAD']), head);
    assert.deepEqual(fs.readFileSync(path.join(dir, '.git', 'index')), index);
    assert.equal(text('git', ['-C', dir, 'worktree', 'list']), trees);
    assert.equal(fs.readFileSync(path.join(dir, 'a'), 'utf8'), 'dirty');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/local.test.mjs`

Expected: FAIL with `Cannot find module` for `local.mjs`.

- [ ] **Step 3: Implement `skills/debate-review/scripts/lib/local.mjs`**

```javascript
// Snapshot a working tree into a throwaway git clone so debate-review can run without a forge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, text, log } from './shell.mjs';

function gitText(repoDir, args, opts) {
  return text('git', ['-C', repoDir, ...args], opts);
}

function isolatedEnv() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
}

function isolatedGit(tmp, hooksDir, args, opts = {}) {
  return run(
    'git',
    ['-C', tmp, '-c', `core.hooksPath=${hooksDir}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', ...args],
    { ...opts, env: { ...isolatedEnv(), ...(opts.env || {}) } },
  );
}

function nulSplit(stdout) {
  return (stdout || '').split('\0').filter(Boolean);
}

export function resolveBase(repoDir, override) {
  if (override) {
    const sha = gitText(repoDir, ['rev-parse', '--verify', `${override}^{commit}`]);
    return { name: override, sha };
  }

  const sym = run('git', ['-C', repoDir, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (sym.status === 0) {
    const ref = sym.stdout.trim();
    const sha = gitText(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`]);
    const name = ref.replace(/^refs\/remotes\//, '');
    return { name, sha };
  }

  for (const name of ['main', 'master']) {
    const probe = run('git', ['-C', repoDir, 'rev-parse', '--verify', `${name}^{commit}`], { allowFail: true });
    if (probe.status === 0) return { name, sha: probe.stdout.trim() };
  }

  throw new Error('cannot resolve a base branch; pass --base');
}

export function isClean(repoDir) {
  return gitText(repoDir, ['status', '--porcelain']) === '';
}

export function hasUnmerged(repoDir) {
  return gitText(repoDir, ['ls-files', '-u']) !== '';
}

export function hasHiddenIndexBits(repoDir) {
  const raw = run('git', ['-C', repoDir, 'ls-files', '-v', '-z']).stdout;
  for (const entry of nulSplit(raw)) {
    const tag = entry[0];
    if (tag === 'S' || tag === 's') return true;
    if (tag >= 'a' && tag <= 'z') return true;
  }
  return false;
}

function assertWorkTree(repoDir) {
  const probe = run('git', ['-C', repoDir, 'rev-parse', '--is-inside-work-tree'], { allowFail: true });
  if (probe.status !== 0 || probe.stdout.trim() !== 'true') {
    throw new Error(`not a git work tree: ${repoDir}`);
  }
  const head = run('git', ['-C', repoDir, 'rev-parse', '--verify', 'HEAD'], { allowFail: true });
  if (head.status !== 0) throw new Error(`no commits in ${repoDir}`);
}

function gitlinksIn(repoDir) {
  const raw = run('git', ['-C', repoDir, 'ls-files', '-s', '-z']).stdout;
  const set = new Set();
  for (const line of nulSplit(raw)) {
    if (line.startsWith('160000 ')) {
      const tab = line.indexOf('\t');
      if (tab !== -1) set.add(line.slice(tab + 1));
    }
  }
  return set;
}

function indexPaths(repoDir) {
  return new Set(nulSplit(run('git', ['-C', repoDir, 'ls-files', '-z']).stdout));
}

function snapshotPathSet(repoDir) {
  return new Set(nulSplit(run('git', ['-C', repoDir, 'ls-files', '-z', '-co', '--exclude-standard']).stdout));
}

function removeLeafNoFollow(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return;
  }
  if (st.isDirectory() && !st.isSymbolicLink()) fs.rmSync(abs, { recursive: true, force: true });
  else fs.unlinkSync(abs);
}

function rmdirParentsNoFollow(root, rel) {
  const dir = path.dirname(rel);
  if (!dir || dir === '.') return;
  const parts = dir.split(path.sep).filter(Boolean);
  for (let i = parts.length; i > 0; i--) {
    const abs = path.join(root, ...parts.slice(0, i));
    if (abs === root) break;
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        fs.unlinkSync(abs);
        continue;
      }
      fs.rmdirSync(abs);
    } catch {
      break;
    }
  }
}

function mkdirParentsNoFollow(root, rel) {
  const dir = path.dirname(rel);
  if (!dir || dir === '.') return;
  const parts = dir.split(path.sep).filter(Boolean);
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      fs.mkdirSync(cur);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      removeLeafNoFollow(cur);
      fs.mkdirSync(cur);
    }
  }
}

function placePath(repoDir, tmp, rel) {
  const src = path.join(repoDir, rel);
  const dst = path.join(tmp, rel);
  let srcSt;
  try {
    srcSt = fs.lstatSync(src);
  } catch {
    removeLeafNoFollow(dst);
    rmdirParentsNoFollow(tmp, rel);
    return;
  }

  if (srcSt.isFIFO() || srcSt.isSocket() || srcSt.isCharacterDevice() || srcSt.isBlockDevice()) {
    throw new Error(`cannot snapshot special file: ${rel}`);
  }

  mkdirParentsNoFollow(tmp, rel);
  removeLeafNoFollow(dst);

  if (srcSt.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dst);
    return;
  }
  if (srcSt.isFile()) {
    fs.copyFileSync(src, dst);
    try {
      fs.chmodSync(dst, srcSt.mode & 0o777);
    } catch {
      // destination filesystem may not store Unix exec bits
    }
    return;
  }
  throw new Error(`cannot snapshot special file: ${rel}`);
}

function overlay(repoDir, tmp) {
  const snapshot = snapshotPathSet(repoDir);
  const links = new Set([...gitlinksIn(repoDir), ...gitlinksIn(tmp)]);
  if (links.size) log('submodule gitlinks are left at HEAD; dirty submodule trees are not in the snapshot');

  const cloneIndex = indexPaths(tmp);
  const prune = [...cloneIndex].filter((p) => !snapshot.has(p) && !links.has(p));
  prune.sort((a, b) => b.split('/').length - a.split('/').length || b.length - a.length);
  for (const rel of prune) {
    removeLeafNoFollow(path.join(tmp, rel));
    rmdirParentsNoFollow(tmp, rel);
  }

  for (const rel of snapshot) {
    if (links.has(rel)) continue;
    placePath(repoDir, tmp, rel);
  }
}

function branchTitle(repoDir) {
  const r = run('git', ['-C', repoDir, 'branch', '--show-current'], { allowFail: true });
  const name = (r.stdout || '').trim();
  return name || 'HEAD';
}

function buildPr(repoDir, tmp, resolved, madeCommit) {
  const title = branchTitle(repoDir);
  const head = gitText(tmp, ['rev-parse', 'HEAD']);
  const logLines = run('git', ['-C', repoDir, 'log', '--oneline', `${resolved.sha}..HEAD`], { allowFail: true }).stdout.trim();
  let body = logLines;
  if (madeCommit) {
    const note = 'Snapshot includes uncommitted and untracked files (respecting .gitignore).';
    body = body ? `${body}\n\n${note}` : note;
  }
  return {
    title,
    body,
    url: '',
    head,
    headRef: title,
    baseRef: resolved.name,
    baseSha: resolved.sha,
    fetchRef: null,
    local: true,
  };
}

export function snapshotWorkingTree(repoDir, { keep = false, base } = {}) {
  repoDir = path.resolve(repoDir);
  assertWorkTree(repoDir);
  if (hasUnmerged(repoDir)) throw new Error('cannot snapshot a conflicted working tree');
  if (hasHiddenIndexBits(repoDir)) {
    throw new Error('cannot snapshot skip-worktree or assume-unchanged paths; unset those bits or disable sparse-checkout');
  }
  const resolved = resolveBase(repoDir, base);
  const userHead = gitText(repoDir, ['rev-parse', 'HEAD']);

  if (fs.existsSync(path.join(repoDir, '.gitmodules'))) {
    log('submodule dirty state is not in the snapshot');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-review-local-'));
  const cleanupNow = () => {
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  };

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    run('git', ['clone', '--local', '--no-checkout', repoDir, tmp], { env: isolatedEnv() });
    const hooksDir = path.join(tmp, '.git', 'debate-review-empty-hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    isolatedGit(tmp, hooksDir, ['checkout', '--detach', '--quiet', userHead]);

    let madeCommit = false;
    if (!isClean(repoDir)) {
      overlay(repoDir, tmp);
      isolatedGit(tmp, hooksDir, ['add', '-A']);
      const cached = isolatedGit(tmp, hooksDir, ['diff', '--cached', '--quiet', 'HEAD', '--'], { allowFail: true });
      if (cached.status !== 0) {
        isolatedGit(tmp, hooksDir, [
          '-c', 'user.name=debate-review',
          '-c', 'user.email=debate-review@local',
          'commit', '--no-verify', '-m', 'debate-review local snapshot',
        ]);
        madeCommit = true;
      }
    }

    const pr = buildPr(repoDir, tmp, resolved, madeCommit);
    return {
      dir: tmp,
      pr,
      cleanup: () => {
        if (keep) log(`keeping local snapshot at ${tmp}`);
        else fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  } catch (error) {
    cleanupNow();
    throw error;
  }
}
```

- [ ] **Step 4: Run local tests**

Run: `node --test test/local.test.mjs`

Expected: all PASS. CI is `ubuntu-latest` (`mkfifo` exists). `git ls-files -s` lines start with `160000 ` and a tab before the path; `gitlinksIn` matches that.

- [ ] **Step 5: Run the full gate**

Run: `node --test test/*.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/debate-review/scripts/lib/local.mjs test/local.test.mjs
git commit -m "$(cat <<'EOF'
debate-review: snapshot a working tree in a throwaway clone

EOF
)"
```

---

### Task 3: Wire `--local` into `review-pr.mjs`

**Files:**
- Modify: `skills/debate-review/scripts/review-pr.mjs`
- Test: `test/review-pr.test.mjs`

**Interfaces:**
- Consumes: `snapshotWorkingTree(repoDir, { keep, base })` from Task 2; `opts.local` from Task 1
- Produces: `--local` never calls forge helpers; `resolveRole(..., { cwd: repoDir })`; `dispatch(..., { cwd: snapshot.dir })`; print path is `opts.dryRun || opts.local`; `finally` calls `snapshot.cleanup()`

- [ ] **Step 1: Write the spawn test for a non-repo `--repo-dir`**

Add to `test/review-pr.test.mjs`:

```javascript
test('review-pr: --local --repo-dir non-repo exits 1 after parsing', () => {
  const script = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
  const missing = path.join(os.tmpdir(), 'dr-not-a-repo-' + process.pid);
  fs.rmSync(missing, { recursive: true, force: true });
  fs.mkdirSync(missing);
  const result = spawnSync('node', [script, '--local', '--repo-dir', missing], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a git work tree/);
  fs.rmSync(missing, { recursive: true, force: true });
});
```

Add `import fs from 'node:fs';` and `import os from 'node:os';` at the top of `test/review-pr.test.mjs` if they are not already imported.

- [ ] **Step 2: Run that test to verify it fails**

Run: `node --test --test-name-pattern 'non-repo' test/review-pr.test.mjs`

Expected: FAIL. Today `main()` still calls `parseTarget(opts.target)` with `target` unset (`TypeError`), stderr will not contain `not a git work tree`.

- [ ] **Step 3: Wire `main()`**

At the top of `skills/debate-review/scripts/review-pr.mjs`, add:

```javascript
import { snapshotWorkingTree } from './lib/local.mjs';
```

Replace the `main()` function with:

```javascript
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let target = null;
  let pr;
  let clone;
  let worktree;
  let localSnapshot = null;
  let repoDirForRoles;
  const printOnly = Boolean(opts.local || opts.dryRun);

  if (opts.local) {
    repoDirForRoles = opts.repoDir
      ? path.resolve(opts.repoDir)
      : text('git', ['rev-parse', '--show-toplevel']);
    localSnapshot = snapshotWorkingTree(repoDirForRoles, { keep: opts.keep, base: opts.base });
    pr = localSnapshot.pr;
    worktree = localSnapshot.dir;
    clone = localSnapshot.dir;
    log(`local ${path.basename(repoDirForRoles)} @ ${pr.head.slice(0, 10)} (${pr.headRef} → ${pr.baseRef})`);
  } else {
    target = parseTarget(opts.target, currentOrigin());
    pr = fetchPR(target);
    log(`${projectPath(target)}#${target.number} @ ${pr.head.slice(0, 10)} (${pr.headRef} → ${pr.baseRef})`);

    if (!opts.force && !opts.dryRun && alreadyReviewed(target, pr)) {
      log('this head already has a debate-review; use --force to post another');
      process.exit(3);
    }

    clone = findClone(target, opts);
    worktree = makeWorktree(clone, pr, pr.baseRef);
    repoDirForRoles = clone;
  }

  const baseRef = opts.local ? pr.baseSha : (opts.base || pr.baseSha);

  const outDir = opts.outDir || (opts.local
    ? path.join(
      os.homedir(),
      '.cache',
      'debate-review',
      'local',
      path.basename(repoDirForRoles),
      pr.headRef.replace(/\//g, '__'),
      pr.head.slice(0, 12),
    )
    : path.join(
      os.homedir(),
      '.cache',
      'debate-review',
      `${target.owner.replace(/\//g, '__')}__${target.repo}`,
      String(target.number),
      pr.head.slice(0, 12),
    ));
  fs.mkdirSync(outDir, { recursive: true });

  const runLog = {
    schema: 'debate-review.run.v1',
    local: Boolean(opts.local),
    repoDir: opts.local ? repoDirForRoles : undefined,
    snapshotDir: opts.local ? localSnapshot.dir : undefined,
    base: opts.local ? { name: pr.baseRef, sha: pr.baseSha } : undefined,
    snapshotCommit: opts.local ? pr.head : undefined,
    target,
    pr,
    outDir,
    startedAt: new Date().toISOString(),
    stages: {},
  };
  const save = () => fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(runLog, null, 2));

  try {
    const diff = text('git', ['-C', worktree, 'diff', `${baseRef}...HEAD`]);
    if (!diff.trim()) throw new Error('empty diff, nothing to review');
    const commits = text('git', ['-C', worktree, 'log', `${baseRef}..HEAD`, '--oneline']);
    const lineMap = diffLineMap(diff);

    const who = {
      main: resolveRole('main', { explicit: opts.main, lane: opts.mainLane, cwd: repoDirForRoles }),
      debate: resolveRole('debate', { explicit: opts.debate, lane: opts.debateLane, cwd: repoDirForRoles }),
    };
    runLog.who = who;
    save();

    const common = {
      BASE: baseRef,
      HEAD: pr.head,
      PR_TITLE: pr.title,
      PR_BODY: pr.body.slice(0, 6000) || '(empty)',
    };
    const send = (role, implementer, brief) => dispatch({
      role, who: implementer, brief, cwd: worktree, outDir, timeout: opts.timeout,
    });

    const spec = opts.local ? 'none found, skip the Spec axis' : fetchSpec(target, pr, commits);

    const mainBrief = prompt('review-main.md', {
      ...common,
      SPEC: spec,
      STANDARDS: findStandards(worktree),
      SCHEMA_FINDINGS: schemaSection(1),
    });
    const mainRun = send('main', who.main, mainBrief);
    const findings = validateFindings(extractJson(mainRun.text));
    findings.findings = findings.findings.filter(f => (f.confidence ?? 1) >= opts.minConfidence);
    runLog.stages.main = { seconds: mainRun.seconds, doc: findings };
    save();
    log(`main: ${findings.findings.length} finding(s) after the confidence filter`);

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

    if (printOnly) {
      const kind = opts.local ? 'local' : 'dry-run';
      process.stdout.write(`\n===== REVIEW BODY =====\n${body}\n`);
      for (const c of comments) {
        const range = c.start_line ? `${c.start_line}-${c.line}` : String(c.line);
        process.stdout.write(`\n===== ${c.path}:${range} =====\n${c.body}\n`);
      }
      process.stdout.write(`\n(${kind}: nothing posted; artifacts in ${outDir})\n`);
    } else {
      const result = postReview(target, pr, body, comments);
      runLog.postResult = result;
      save();
      log(`posted ${comments.length} inline comment(s): ${result.url}`);
      process.stdout.write(`${result.url}\n`);
    }
  } finally {
    if (opts.local) {
      if (localSnapshot) localSnapshot.cleanup();
    } else if (!opts.keep) {
      removeWorktree(clone, worktree);
    }
    runLog.finishedAt = new Date().toISOString();
    try { save(); } catch { /* snapshot cleanup may have already finished */ }
  }
}
```

Update the file header comment so step 4 mentions `--local` / print.

`--force` on `--local` is ignored because `alreadyReviewed` is not called.

Empty local diffs still throw `empty diff, nothing to review` (exit 1 via `main().catch`). That is correct: parsing succeeded.

- [ ] **Step 4: Run tests**

Run: `node --test test/*.test.mjs`

Expected: PASS, including `review-pr: --local --repo-dir non-repo exits 1 after parsing`.

- [ ] **Step 5: Commit**

```bash
git add skills/debate-review/scripts/review-pr.mjs test/review-pr.test.mjs
git commit -m "$(cat <<'EOF'
debate-review: run the debate against a local working tree

EOF
)"
```

---

### Task 4: SKILL.md and README

**Files:**
- Modify: `skills/debate-review/SKILL.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: CLI table from the spec; `--local` behavior from Task 3
- Produces: agent instructions that do not invent a PR URL; README "Local preview" section

- [ ] **Step 1: Update `skills/debate-review/SKILL.md`**

Replace the YAML `description` with:

```yaml
description: Two-model debate review of a GitHub PR, GitLab MR, or local working tree, posted as inline comments or printed. Use for any PR/MR review request, or a local review before a PR exists.
```

In `## Run it`, replace the command block and the `--dry-run` bullet with:

```markdown
```bash
node "<skill-dir>/scripts/review-pr.mjs" --local [--base <ref>]
node "<skill-dir>/scripts/review-pr.mjs" <pr-url | number> [--dry-run]
```

- If the user wants a review and there is no PR/MR URL, run `--local` from the repo (or `--repo-dir`). Do not invent a URL. Relay stdout. `--local` never talks to GitHub or GitLab.
- `<pr-url>` is a GitHub `/pull/N` or GitLab `/-/merge_requests/N` URL. A bare number resolves against
  the cwd's `origin`.
- `--dry-run` prints a live PR review instead of posting it. It does not combine with `--local`.
```

Keep the existing bullets on lanes, exit 3, backgrounding. Add to Artifacts:

```markdown
`--local` writes under `~/.cache/debate-review/local/<repo>/<branch>/<head>/` instead.
```

- [ ] **Step 2: Update `README.md`**

In the "Then ask your agent" block, add:

```text
Use $debate-review --local on this repo before I open a PR.
```

After `## Run it by hand`, change the command block to:

```bash
node "<skill-dir>/scripts/review-pr.mjs" --local                  # working tree; print, no forge
node "<skill-dir>/scripts/review-pr.mjs" <pr-url | number> --dry-run   # print, do not post
node "<skill-dir>/scripts/review-pr.mjs" <pr-url | number>             # post
"<babysit-skill-dir>/scripts/threads.sh" <number>                      # harvest one round as JSON
```

Insert this section immediately before `## Run it by hand`:

```markdown
## Local preview

`--local` reviews the files on disk (committed, uncommitted, and untracked, honoring `.gitignore`)
against a base branch. It never calls `gh` or `glab`. `--dry-run` still needs a live PR; it only
skips the post. The two flags do not combine.

| Invocation | Source | Forge | Post |
| --- | --- | --- | --- |
| `--local` | Working tree snapshot | No | No |
| `<pr> --dry-run` | Live PR | Yes | No |
| `<pr>` | Live PR | Yes | Yes |
```

In the flags sentence under "Run it by hand", mention `--local`.

- [ ] **Step 3: Run the gate (docs must not break the skills CLI)**

Run:

```bash
node --test test/*.test.mjs
npx -y skills add . --list
```

Expected: tests PASS; `skills add --list` still lists `debate-review` and `babysit-pr`. If YAML in `SKILL.md` fails to parse, the colon in the description must be quoted (the whole description is already a YAML string).

- [ ] **Step 4: Commit**

```bash
git add skills/debate-review/SKILL.md README.md
git commit -m "$(cat <<'EOF'
docs: debate-review --local working-tree preview

EOF
)"
```

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| CLI split, exit 2 combinations | 1 |
| `--local --repo-dir` non-repo exit 1 | 3 |
| `resolveBase` order | 2 |
| Hidden bits / unmerged fail closed | 2 |
| Throwaway `clone --local`, isolation, cleanup | 2 |
| Prune-before-copy, C1 symlink escape | 2 |
| Gitlinks skipped (C2) | 2 |
| Exec bits (C6) | 2 |
| Fast path, overlay membership, user repo unchanged | 2 |
| `resolveRole` from `repoDir`, relays in tmp | 3 |
| Never `fetchSpec` / `postReview` / fake target | 3 |
| Print like dry-run, artifacts `local/<repo>/<branch>/<head12>` | 3 |
| SKILL.md / README | 4 |
| No babysit-pr, no later post, no network deny, no C-quote anchors, 64 MiB buffer | non-goals; not implemented |
