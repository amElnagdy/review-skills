// Snapshot a working tree into a throwaway git clone so debate-review can run without a forge.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { run, text, log } from './shell.mjs';

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

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

/** Path handling is string-based; a lossy decode would silently drop or mangle files, so fail closed. */
function strictUtf8(raw) {
  try {
    return STRICT_UTF8.decode(raw);
  } catch {
    throw new Error('cannot snapshot non-UTF-8 Git paths; rename them before local review');
  }
}

function gitPathSplit(raw) {
  return nulSplit(strictUtf8(raw));
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

function withoutIndexRefresh(opts = {}) {
  return { ...opts, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...(opts.env || {}) } };
}

export function isClean(repoDir) {
  return gitText(repoDir, ['status', '--porcelain', '--untracked-files=normal'], withoutIndexRefresh()) === '';
}

/** Paths git itself treats as dirty, including every untracked file (`-uall`). Rename records yield both names. */
function worktreeStatusPaths(repoDir) {
  const raw = run(
    'git',
    ['-C', repoDir, 'status', '--porcelain', '-z', '--untracked-files=all'],
    withoutIndexRefresh({ encoding: null }),
  ).stdout;
  const tokens = strictUtf8(raw).split('\0');
  const paths = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4 || entry[2] !== ' ') continue;
    const code = entry.slice(0, 2);
    paths.add(entry.slice(3));
    if (code.includes('R') || code.includes('C')) {
      i += 1;
      if (tokens[i]) paths.add(tokens[i]);
    }
  }
  return paths;
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

function gitlinkEntries(repoDir) {
  const raw = run('git', ['-C', repoDir, 'ls-files', '-s', '-z']).stdout;
  const map = new Map();
  for (const line of nulSplit(raw)) {
    if (line.startsWith('160000 ')) {
      const tab = line.indexOf('\t');
      if (tab !== -1) map.set(line.slice(tab + 1), line.slice(7, tab).split(' ')[0]);
    }
  }
  return map;
}

function indexPaths(repoDir) {
  return new Set(gitPathSplit(run('git', ['-C', repoDir, 'ls-files', '-z'], { encoding: null }).stdout));
}

function snapshotPathSet(repoDir) {
  const raw = run('git', ['-C', repoDir, 'ls-files', '-z', '-co', '--exclude-standard'], { encoding: null }).stdout;
  return new Set(gitPathSplit(raw));
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

/** Git relative paths use `/` even on Windows; `path.sep` would collapse `new/deep`. */
function gitParentParts(rel) {
  const parts = rel.split('/').filter(Boolean);
  parts.pop();
  return parts;
}

function rmdirParentsNoFollow(root, rel) {
  const parts = gitParentParts(rel);
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
  const parts = gitParentParts(rel);
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
      } catch (error) {
        // A directory that vanished mid-walk is fine; an unreadable one would silently
        // truncate the snapshot, so refuse rather than review incomplete code.
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
        throw new Error(`cannot read directory in the working tree: ${rel || '.'} (${error.code})`);
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
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
        throw new Error(`cannot stat path in the working tree: ${rel} (${error.code})`);
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

function sourceIndexMode(repoDir, rel) {
  const raw = run('git', ['-C', repoDir, '--literal-pathspecs', 'ls-files', '-s', '-z', '--', rel]).stdout;
  for (const entry of nulSplit(raw)) {
    const tab = entry.indexOf('\t');
    // The pathspec also matches descendants (rel as a directory); only the exact entry counts.
    if (tab === -1 || entry.slice(tab + 1) !== rel) continue;
    const [mode, , stage] = entry.slice(0, tab).split(' ');
    if (stage === '0') return mode;
  }
  return null;
}

/** How the worktree presents a source-index gitlink. git reports a missing path as an unstaged
    deletion and a file/symlink as an unstaged typechange, but treats any directory — populated,
    dirty, or a plain (even nonempty) dir without .git — as a submodule worktree that stays clean. */
function gitlinkWorktreeState(repoDir, rel) {
  let st;
  try {
    st = fs.lstatSync(path.join(repoDir, rel));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
    throw new Error(`cannot stat path in the working tree: ${rel} (${error.code})`);
  }
  return st.isDirectory() && !st.isSymbolicLink() ? 'submodule' : 'replaced';
}

function overlay(repoDir, tmp, snapshot) {
  const dirty = worktreeStatusPaths(repoDir);
  // Only gitlinks whose worktree is still a submodule directory exclude paths from staging.
  // Gitlinks that exist solely at HEAD (staged removal/typechange) or whose worktree was
  // deleted or replaced by a file must flow through normal staging so the change is snapshotted.
  const links = new Set(
    [...gitlinkEntries(repoDir).keys()].filter((rel) => gitlinkWorktreeState(repoDir, rel) === 'submodule'),
  );
  assertNoSpecialFiles(repoDir, links);
  if (links.size || gitlinkEntries(tmp).size) log('staged gitlink changes are in the snapshot; dirty submodule trees are not');

  const cloneIndex = indexPaths(tmp);
  const prune = [...cloneIndex].filter((p) => !links.has(p) && (!snapshot.has(p) || sourceHasSymlinkParent(repoDir, p)));
  prune.sort((a, b) => b.split('/').length - a.split('/').length || b.length - a.length);
  for (const rel of prune) {
    removeLeafNoFollow(path.join(tmp, rel));
    rmdirParentsNoFollow(tmp, rel);
  }

  // Recopying unchanged files would restage smudged/filter/mode bytes as phantom diffs.
  // underGitlink also skips stale index descendants (dir→gitlink) so submodule contents never copy.
  for (const rel of dirty) {
    if (underGitlink(rel, links) || sourceHasSymlinkParent(repoDir, rel)) continue;
    placePath(repoDir, tmp, rel);
  }
  return [...dirty].filter((rel) => {
    if (underGitlink(rel, links) || sourceHasSymlinkParent(repoDir, rel)) return false;
    try {
      const st = fs.lstatSync(path.join(tmp, rel));
      return !(st.isDirectory() && !st.isSymbolicLink());
    } catch {
      return cloneIndex.has(rel);
    }
  });
}

/** Hash through the source repo so clean filters/CRLF apply, but write the blob only into the clone. */
function stageDirtyPaths(repoDir, tmp, hooksDir, staged) {
  const fileMode = run('git', ['-C', repoDir, 'config', '--bool', '--get', 'core.fileMode'], { allowFail: true });
  const trustFileMode = fileMode.status !== 0 || fileMode.stdout.trim() !== 'false';
  const symlinks = run('git', ['-C', repoDir, 'config', '--bool', '--get', 'core.symlinks'], { allowFail: true });
  const materializedSymlinks = symlinks.status === 0 && symlinks.stdout.trim() === 'false';
  const hashable = [];
  const leftover = [];
  for (const rel of staged) {
    let st;
    try {
      st = fs.lstatSync(path.join(repoDir, rel));
    } catch {
      leftover.push(rel);
      continue;
    }
    if (st.isFile()) hashable.push({ rel, st });
    else leftover.push(rel);
  }
  // `add` must run before `update-index --replace`: --replace evicts D/F-conflicting
  // index entries that these pathspecs still need to match (e.g. a/b when a becomes a file).
  if (leftover.length) {
    isolatedGit(tmp, hooksDir, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      input: `${leftover.join('\0')}\0`,
    });
  }
  for (const { rel, st } of hashable) {
    const src = path.join(repoDir, rel);
    const indexMode = sourceIndexMode(repoDir, rel);
    let mode = (st.mode & 0o111) ? '100755' : '100644';
    if (indexMode === '120000' && materializedSymlinks) mode = '120000';
    else if (!trustFileMode) mode = indexMode === '100755' ? '100755' : '100644';
    const hashArgs = mode === '120000'
      ? ['hash-object', '-w', '--stdin']
      : ['hash-object', '-w', '--path', rel, '--stdin'];
    const sha = text('git', ['-C', repoDir, ...hashArgs], {
      env: {
        ...process.env,
        GIT_OBJECT_DIRECTORY: path.join(tmp, '.git', 'objects'),
        GIT_OPTIONAL_LOCKS: '0',
      },
      input: fs.readFileSync(src),
    });
    isolatedGit(tmp, hooksDir, ['update-index', '--add', '--replace', '--cacheinfo', `${mode},${sha},${rel}`]);
  }
}

/** Superproject index changes to gitlinks (staged sha updates, adds, removals) are part of the
    review diff; the overlay skips gitlink paths, so mirror the source index entries directly.
    Dirty state inside a submodule worktree stays excluded because only the index is consulted. */
function syncGitlinks(repoDir, tmp, hooksDir) {
  const source = gitlinkEntries(repoDir);
  const clone = gitlinkEntries(tmp);
  for (const [rel, sha] of source) {
    const state = gitlinkWorktreeState(repoDir, rel);
    if (state === 'submodule') {
      if (clone.get(rel) !== sha) {
        isolatedGit(tmp, hooksDir, ['update-index', '--add', '--replace', '--cacheinfo', `160000,${sha},${rel}`]);
      }
      continue;
    }
    // missing → unstaged deletion; replaced → the overlay staged the disk file over the gitlink.
    if (clone.has(rel)) {
      isolatedGit(tmp, hooksDir, ['update-index', '--force-remove', '--', rel]);
    }
  }
  for (const rel of clone.keys()) {
    if (!source.has(rel)) {
      isolatedGit(tmp, hooksDir, ['update-index', '--force-remove', '--', rel]);
    }
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
  const snapshotPaths = snapshotPathSet(repoDir);
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
      const staged = overlay(repoDir, tmp, snapshotPaths);
      if (staged.length) stageDirtyPaths(repoDir, tmp, hooksDir, staged);
      syncGitlinks(repoDir, tmp, hooksDir);
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
