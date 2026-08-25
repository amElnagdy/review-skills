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
    const probe = run('git', ['-C', repoDir, 'rev-parse', '--verify', `${ref}^{commit}`], { allowFail: true });
    if (probe.status === 0) {
      const name = ref.replace(/^refs\/remotes\//, '');
      return { name, sha: probe.stdout.trim() };
    }
  }

  for (const name of ['main', 'master']) {
    const probe = run('git', ['-C', repoDir, 'rev-parse', '--verify', `${name}^{commit}`], { allowFail: true });
    if (probe.status === 0) return { name, sha: probe.stdout.trim() };
  }

  throw new Error('cannot resolve a base branch; pass --base');
}

export function isClean(repoDir) {
  return gitText(repoDir, ['status', '--porcelain', '--untracked-files=normal'], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }) === '';
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

function isSpecialFile(st) {
  return st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice();
}

function ignoredSet(repoDir, rels) {
  if (!rels.length) return new Set();
  const result = run('git', ['-C', repoDir, 'check-ignore', '-z', '--stdin'], {
    allowFail: true,
    input: `${rels.join('\0')}\0`,
  });
  return new Set(nulSplit(result.stdout));
}

function underGitlink(rel, links) {
  if (!rel) return false;
  if (links.has(rel)) return true;
  for (const link of links) {
    if (rel.startsWith(`${link}/`)) return true;
  }
  return false;
}

function isNestedGitDir(abs, st) {
  return st.isDirectory() && !st.isSymbolicLink() && fs.existsSync(path.join(abs, '.git'));
}

/** Git does not list fifos/sockets, so ls-files will not reach placePath for them. */
function assertNoSpecialFiles(repoDir, links) {
  let frontier = [{ abs: repoDir, rel: '' }];
  while (frontier.length) {
    const children = [];
    for (const { abs, rel } of frontier) {
      let names;
      try {
        names = fs.readdirSync(abs);
      } catch {
        continue;
      }
      for (const name of names) {
        if (rel === '' && name === '.git') continue;
        const childRel = rel ? `${rel}/${name}` : name;
        if (underGitlink(childRel, links)) continue;
        children.push({ abs: path.join(abs, name), rel: childRel });
      }
    }
    const ignored = ignoredSet(repoDir, children.map((c) => c.rel));
    const next = [];
    for (const { abs, rel } of children) {
      if (ignored.has(rel)) continue;
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (isNestedGitDir(abs, st)) continue;
      if (isSpecialFile(st)) throw new Error(`cannot snapshot special file: ${rel}`);
      if (st.isDirectory() && !st.isSymbolicLink()) next.push({ abs, rel });
    }
    frontier = next;
  }
}

function placePath(repoDir, tmp, rel) {
  if (sourceHasSymlinkParent(repoDir, rel)) return;

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

  if (isSpecialFile(srcSt)) {
    throw new Error(`cannot snapshot special file: ${rel}`);
  }

  // Index may still name this path after a typechange to a directory; children are copied as their own paths.
  if (srcSt.isDirectory() && !srcSt.isSymbolicLink()) {
    let dstSt;
    try {
      dstSt = fs.lstatSync(dst);
    } catch {
      dstSt = null;
    }
    if (dstSt && !(dstSt.isDirectory() && !dstSt.isSymbolicLink())) removeLeafNoFollow(dst);
    return;
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

/** lstat follows intermediate symlinks; skip stale index descendants under a replacement symlink. */
function sourceHasSymlinkParent(repoDir, rel) {
  const parts = rel.split('/').filter(Boolean);
  let cur = repoDir;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return false;
    }
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

function overlay(repoDir, tmp) {
  const snapshot = snapshotPathSet(repoDir);
  const links = new Set([...gitlinksIn(repoDir), ...gitlinksIn(tmp)]);
  assertNoSpecialFiles(repoDir, links);
  if (links.size) log('submodule gitlinks are left at HEAD; dirty submodule trees are not in the snapshot');

  const cloneIndex = indexPaths(tmp);
  const prune = [...cloneIndex].filter((p) => !links.has(p) && (!snapshot.has(p) || sourceHasSymlinkParent(repoDir, p)));
  prune.sort((a, b) => b.split('/').length - a.split('/').length || b.length - a.length);
  for (const rel of prune) {
    removeLeafNoFollow(path.join(tmp, rel));
    rmdirParentsNoFollow(tmp, rel);
  }

  for (const rel of snapshot) {
    if (links.has(rel) || sourceHasSymlinkParent(repoDir, rel)) continue;
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
  repoDir = gitText(repoDir, ['rev-parse', '--show-toplevel']);
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
    for (const key of ['core.fileMode', 'core.autocrlf', 'core.symlinks']) {
      const sourceSetting = run('git', ['-C', repoDir, 'config', '--get', key], { allowFail: true });
      if (sourceSetting.status === 0 && sourceSetting.stdout.trim() !== '') {
        isolatedGit(tmp, hooksDir, ['config', key, sourceSetting.stdout.trim()]);
      }
    }
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
