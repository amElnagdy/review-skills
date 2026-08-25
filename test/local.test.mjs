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

    run('git', ['-C', dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone']);
    const fallback = resolveBase(dir);
    assert.equal(fallback.name, 'main');
    assert.equal(fallback.sha, mainSha);
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

    run('git', ['-C', dir, 'config', 'status.showUntrackedFiles', 'no']);
    fs.writeFileSync(path.join(dir, 'fresh.txt'), 'fresh');
    assert.equal(isClean(dir), false);
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

test('snapshot overlay: directory at HEAD replaced by a symlink does not copy through it', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-local-outside-dir-'));
  try {
    fs.writeFileSync(path.join(outside, 'b'), 'leaked');
    fs.writeFileSync(path.join(outside, 'secret'), 'leaked');
    withRepo((dir) => {
      fs.mkdirSync(path.join(dir, 'a'));
      fs.writeFileSync(path.join(dir, 'a', 'b'), 'inside');
      commitAll(dir, 'dir');

      fs.rmSync(path.join(dir, 'a'), { recursive: true });
      fs.symlinkSync(outside, path.join(dir, 'a'));

      const snap = snapshotWorkingTree(dir, { keep: false });
      try {
        const st = fs.lstatSync(path.join(snap.dir, 'a'));
        assert.equal(st.isSymbolicLink(), true);
        assert.match(text('git', ['-C', snap.dir, 'ls-files', '-s', 'a']), /^120000 /);
        const tree = text('git', ['-C', snap.dir, 'ls-tree', '-r', '--name-only', 'HEAD']);
        assert.doesNotMatch(tree, /^a\/b$/m);
        assert.doesNotMatch(tree, /^a\/secret$/m);
      } finally {
        snap.cleanup();
      }
    });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
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

test('snapshot overlay: tracked file replaced by a directory stages its descendants', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'old');
    commitAll(dir, 'file');
    fs.unlinkSync(path.join(dir, 'a'));
    fs.mkdirSync(path.join(dir, 'a'));
    fs.writeFileSync(path.join(dir, 'a', 'b'), 'new');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      assert.equal(fs.readFileSync(path.join(snap.dir, 'a', 'b'), 'utf8'), 'new');
      assert.match(text('git', ['-C', snap.dir, 'ls-tree', '-r', '--name-only', 'HEAD']), /^a\/b$/m);
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: tracked directory replaced by a file stages the file', () => {
  withRepo((dir) => {
    fs.mkdirSync(path.join(dir, 'a'));
    fs.writeFileSync(path.join(dir, 'a', 'b'), 'old');
    fs.writeFileSync(path.join(dir, 'a', 'c'), 'old2');
    commitAll(dir, 'dir');
    fs.rmSync(path.join(dir, 'a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a'), 'new');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      assert.equal(text('git', ['-C', snap.dir, 'show', 'HEAD:a']), 'new');
      const tree = text('git', ['-C', snap.dir, 'ls-tree', '-r', '--name-only', 'HEAD']);
      assert.match(tree, /^a$/m);
      assert.doesNotMatch(tree, /^a\//m);
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot rejects non-UTF-8 Git paths instead of omitting them', { skip: process.platform !== 'linux' }, () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'base'), 'base');
    commitAll(dir, 'base');
    const invalidPath = Buffer.concat([Buffer.from(`${dir}${path.sep}bad-`), Buffer.from([0xff])]);
    fs.writeFileSync(invalidPath, 'x');
    assert.throws(() => snapshotWorkingTree(dir, { keep: false }), /non-UTF-8 Git paths/);
  });
});

test('snapshot overlay: backslashes in Unix filenames are not path separators', { skip: process.platform === 'win32' }, () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'target'), 'target');
    fs.symlinkSync('target', path.join(dir, 'a'));
    fs.mkdirSync(path.join(dir, 'a\\b'));
    fs.writeFileSync(path.join(dir, 'a\\b', 'f'), 'kept');
    fs.writeFileSync(path.join(dir, 'dirty'), 'old');
    commitAll(dir, 'backslash');
    fs.writeFileSync(path.join(dir, 'dirty'), 'new');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      assert.equal(fs.readFileSync(path.join(snap.dir, 'a\\b', 'f'), 'utf8'), 'kept');
      const changed = text('git', ['-C', snap.dir, 'diff', '--name-only', 'HEAD~1', 'HEAD']);
      assert.equal(changed, 'dirty');
    } finally {
      snap.cleanup();
    }
  });
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

test('snapshot overlay: core.fileMode=false does not invent mode-only diffs', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'tool.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, 'a'), 'a\n');
    commitAll(dir, 'mode');
    run('git', ['-C', dir, 'config', 'core.fileMode', 'false']);
    fs.chmodSync(path.join(dir, 'tool.sh'), 0o755);
    fs.writeFileSync(path.join(dir, 'a'), 'dirty\n');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      const stage = text('git', ['-C', snap.dir, 'ls-files', '-s', 'tool.sh']);
      assert.match(stage, /^100644 /);
      const diff = text('git', ['-C', snap.dir, 'diff', 'HEAD~1', 'HEAD']);
      assert.doesNotMatch(diff, /mode change/);
      assert.match(diff, /dirty/);
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: core.fileMode=false preserves mode on a dirty file', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'tool.sh'), 'old\n');
    commitAll(dir, 'mode');
    run('git', ['-C', dir, 'config', 'core.fileMode', 'false']);
    fs.chmodSync(path.join(dir, 'tool.sh'), 0o755);
    fs.writeFileSync(path.join(dir, 'tool.sh'), 'new\n');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      assert.match(text('git', ['-C', snap.dir, 'ls-tree', 'HEAD', 'tool.sh']), /^100644 /);
      assert.equal(text('git', ['-C', snap.dir, 'show', 'HEAD:tool.sh']), 'new');
      assert.doesNotMatch(text('git', ['-C', snap.dir, 'diff', '--summary', 'HEAD~1', 'HEAD']), /mode change/);
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: core.autocrlf=true does not invent CRLF diffs', () => {
  withRepo((dir) => {
    run('git', ['-C', dir, 'config', 'core.autocrlf', 'true']);
    fs.writeFileSync(path.join(dir, 'same.txt'), 'same\r\n');
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'old\r\n');
    commitAll(dir, 'crlf');
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'new\r\n');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      const changed = text('git', ['-C', snap.dir, 'diff', '--name-only', 'HEAD~1', 'HEAD']);
      assert.equal(changed, 'dirty.txt');
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: nested untracked files are created parent-by-parent', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    fs.mkdirSync(path.join(dir, 'new', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'new', 'deep', 'file.txt'), 'x');
    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      assert.equal(fs.readFileSync(path.join(snap.dir, 'new', 'deep', 'file.txt'), 'utf8'), 'x');
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: clean filters on unchanged files do not invent diffs', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'filtered.txt filter=upper\n');
    fs.writeFileSync(path.join(dir, 'filtered.txt'), 'hello\n');
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'old\n');
    run('git', ['-C', dir, 'config', 'filter.upper.clean', 'tr a-z A-Z']);
    run('git', ['-C', dir, 'config', 'filter.upper.smudge', 'tr A-Z a-z']);
    commitAll(dir, 'filter');
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'new\n');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      const changed = text('git', ['-C', snap.dir, 'diff', '--name-only', 'HEAD~1', 'HEAD']);
      assert.equal(changed, 'dirty.txt');
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: dirty filtered files are staged with the source clean filter', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'filtered.txt filter=upper\n');
    fs.writeFileSync(path.join(dir, 'filtered.txt'), 'hello\n');
    run('git', ['-C', dir, 'config', 'filter.upper.clean', 'tr a-z A-Z']);
    run('git', ['-C', dir, 'config', 'filter.upper.smudge', 'tr A-Z a-z']);
    commitAll(dir, 'filter');
    fs.writeFileSync(path.join(dir, 'filtered.txt'), 'world\n');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      assert.equal(text('git', ['-C', snap.dir, 'show', 'HEAD:filtered.txt']), 'WORLD');
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: core.symlinks=false does not invent type changes', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'target.txt'), 'target\n');
    fs.symlinkSync('target.txt', path.join(dir, 'link'));
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'old\n');
    commitAll(dir, 'symlink');
    run('git', ['-C', dir, 'config', 'core.symlinks', 'false']);
    fs.unlinkSync(path.join(dir, 'link'));
    fs.writeFileSync(path.join(dir, 'link'), 'target.txt');
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'new\n');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      const changed = text('git', ['-C', snap.dir, 'diff', '--name-only', 'HEAD~1', 'HEAD']);
      assert.equal(changed, 'dirty.txt');
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: core.symlinks=false preserves a dirty symlink', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'one'), 'one\n');
    fs.writeFileSync(path.join(dir, 'two'), 'two\n');
    fs.symlinkSync('one', path.join(dir, 'link'));
    commitAll(dir, 'symlink');
    run('git', ['-C', dir, 'config', 'core.symlinks', 'false']);
    fs.unlinkSync(path.join(dir, 'link'));
    fs.writeFileSync(path.join(dir, 'link'), 'two');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      assert.match(text('git', ['-C', snap.dir, 'ls-tree', 'HEAD', 'link']), /^120000 /);
      assert.equal(text('git', ['-C', snap.dir, 'show', 'HEAD:link']), 'two');
      assert.doesNotMatch(text('git', ['-C', snap.dir, 'diff', '--summary', 'HEAD~1', 'HEAD']), /mode change/);
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

test('snapshot overlay: staged gitlink update, add, and removal reach the snapshot', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    const sha1 = text('git', ['-C', dir, 'rev-parse', 'HEAD']);
    run('git', ['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${sha1},vendor/dep`]);
    run('git', ['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${sha1},vendor/gone`]);
    run('git', ['-C', dir, 'commit', '-m', 'gitlinks']);
    const sha2 = text('git', ['-C', dir, 'rev-parse', 'HEAD']);

    run('git', ['-C', dir, 'update-index', '--cacheinfo', `160000,${sha2},vendor/dep`]);
    run('git', ['-C', dir, 'rm', '--cached', 'vendor/gone']);
    run('git', ['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${sha1},vendor/new`]);

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      const tree = text('git', ['-C', snap.dir, 'ls-tree', '-r', 'HEAD']);
      assert.match(tree, new RegExp(`^160000 commit ${sha2}\\tvendor/dep$`, 'm'));
      assert.match(tree, new RegExp(`^160000 commit ${sha1}\\tvendor/new$`, 'm'));
      assert.doesNotMatch(tree, /vendor\/gone/);
      assert.match(text('git', ['-C', dir, 'ls-tree', 'HEAD', 'vendor/gone']), /^160000 commit /);
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: unstaged submodule commits stay at the recorded gitlink', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    const nested = path.join(dir, 'vendor', 'dep');
    gitInit(nested, 'main');
    fs.writeFileSync(path.join(nested, 'x'), 'x');
    commitAll(nested, 'n1');
    const recorded = text('git', ['-C', nested, 'rev-parse', 'HEAD']);
    run('git', ['-C', dir, 'add', 'vendor/dep']);
    run('git', ['-C', dir, 'commit', '-m', 'sub']);

    fs.writeFileSync(path.join(nested, 'x'), 'x2');
    commitAll(nested, 'n2');
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'd');

    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      assert.match(
        text('git', ['-C', snap.dir, 'ls-tree', 'HEAD', 'vendor/dep']),
        new RegExp(`^160000 commit ${recorded}\\t`),
      );
      assert.match(text('git', ['-C', snap.dir, 'ls-tree', '-r', '--name-only', 'HEAD']), /^dirty\.txt$/m);
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: gitlink working trees are not walked for special files', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    const sha = text('git', ['-C', dir, 'rev-parse', 'HEAD']);
    run('git', ['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${sha},vendor/dep`]);
    run('git', ['-C', dir, 'commit', '-m', 'gitlink']);
    fs.mkdirSync(path.join(dir, 'vendor', 'dep'), { recursive: true });
    run('mkfifo', [path.join(dir, 'vendor', 'dep', 'pipe')]);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'd');
    const snap = snapshotWorkingTree(dir, { keep: false });
    try {
      assert.match(text('git', ['-C', snap.dir, 'ls-files', '-s', 'vendor/dep']), /^160000 /);
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

test('snapshot overlay: nested git directories are not walked for special files', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    const nested = path.join(dir, 'nested');
    gitInit(nested, 'main');
    fs.writeFileSync(path.join(nested, 'x'), 'x');
    commitAll(nested, 'x');
    run('mkfifo', [path.join(nested, 'pipe')]);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'd');
    const snap = snapshotWorkingTree(dir, { keep: false });
    snap.cleanup();
  });
});

test('snapshotWorkingTree: a subdirectory path uses the worktree root', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    commitAll(dir, 'a');
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'b'), 'b');
    const snap = snapshotWorkingTree(sub, { keep: false });
    try {
      assert.equal(fs.readFileSync(path.join(snap.dir, 'a'), 'utf8'), 'a');
      assert.match(text('git', ['-C', snap.dir, 'ls-tree', '-r', '--name-only', 'HEAD']), /^sub\/b$/m);
    } finally {
      snap.cleanup();
    }
  });
});

test('snapshot overlay: ignored directories are not walked for special files', () => {
  withRepo((dir) => {
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'junk/\n');
    commitAll(dir, 'base');
    fs.mkdirSync(path.join(dir, 'junk'));
    run('mkfifo', [path.join(dir, 'junk', 'pipe')]);
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'd');
    const snap = snapshotWorkingTree(dir, { keep: false });
    snap.cleanup();
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
    const indexPath = path.join(dir, '.git', 'index');
    const cleanIndex = fs.readFileSync(indexPath);
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(dir, 'a'), future, future);
    const cleanSnap = snapshotWorkingTree(dir, { keep: false });
    cleanSnap.cleanup();
    assert.deepEqual(fs.readFileSync(indexPath), cleanIndex);

    fs.writeFileSync(path.join(dir, 'a'), 'dirty');
    const head = text('git', ['-C', dir, 'rev-parse', 'HEAD']);
    const index = fs.readFileSync(indexPath);
    const trees = text('git', ['-C', dir, 'worktree', 'list']);

    const snap = snapshotWorkingTree(dir, { keep: false });
    snap.cleanup();

    assert.equal(text('git', ['-C', dir, 'rev-parse', 'HEAD']), head);
    assert.deepEqual(fs.readFileSync(indexPath), index);
    assert.equal(text('git', ['-C', dir, 'worktree', 'list']), trees);
    assert.equal(fs.readFileSync(path.join(dir, 'a'), 'utf8'), 'dirty');
  });
});
