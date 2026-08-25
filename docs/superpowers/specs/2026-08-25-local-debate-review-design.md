# Local debate-review

Date: 2026-08-25
Amended: 2026-08-25 (Codex debate: C1–C9)

`--dry-run` still needs a live GitHub PR or GitLab MR. It only skips the post. This spec adds `--local`: review the files on disk in the current repo, with no forge.

## Problem

`review-pr.mjs` starts by resolving a PR URL or number, calling `gh` or `glab`, fetching the head, and checking it out. There is no way to run the three-pass debate before a PR exists.

## Goal

From a git checkout, run the same debate against a snapshot of what is on disk (committed, uncommitted, and untracked, honoring `.gitignore`) versus a base branch. Print the review. The orchestrator never calls GitHub or GitLab. Leave the user's index, HEAD, refs, worktrees, and object database unchanged. Delete every temporary file the run created.

Delegated reviewers keep today's `--read-only` relay contract. Local mode does not add a network deny.

## Non-goals

- `babysit-pr` against a local review
- Posting a local review onto a PR opened later
- Overlaying submodule working trees (HEAD gitlinks stay as they were at user HEAD)
- Repos with no commits
- Including gitignored files
- Watching the working tree for changes during the run
- Sparse-checkout, skip-worktree, and assume-unchanged worktrees (fail closed; absence on disk is ambiguous)
- Inline anchoring for filenames Git C-quotes; those findings stay in the unanchored review body (`diff.mjs` already splits unified diffs on newlines)
- Patch output above the orchestrator's existing 64 MiB `spawnSync` buffer; the run fails instead of streaming
- Inventing a synthetic forge `target` and sending it through `alreadyReviewed` / `fetchSpec` / `postReview` (`forge.mjs` treats every non-GitHub host as GitLab)

## CLI

Two flags, two jobs. They do not combine.

```text
node review-pr.mjs --local [--base <ref>] [--repo-dir <dir>] [--keep] …
node review-pr.mjs <pr-url | number> --dry-run
node review-pr.mjs <pr-url | number>
```

| Invocation | Source | Forge | Post |
| --- | --- | --- | --- |
| `--local` | Working tree snapshot in a temp clone | No | No |
| `<pr> --dry-run` | Live PR (today) | Yes | No |
| `<pr>` | Live PR (today) | Yes | Yes |
| no args | Usage error (exit 2) | — | — |
| `--local` and a PR argument | Usage error (exit 2) | — | — |
| `--dry-run` and no PR argument | Usage error (exit 2), message names `--local` | — | — |
| `--local --dry-run` | Usage error (exit 2) | — | — |

`--force` with `--local` is ignored. Other existing flags (`--main`, `--debate`, `--base`, `--timeout`, `--keep`, `--out-dir`, `--min-confidence`, `--contested`, lanes) keep their meaning.

`--keep` on `--local` keeps the temp clone and prints its path. It still does not keep anything in the user's repo.

Exit codes are unchanged: 0 printed, 1 failure, 2 usage. Exit 3 (already reviewed) cannot happen on `--local`.

## Snapshot

The relays keep today's brief (`git diff {{BASE}}...{{HEAD}}`). Local mode manufactures a HEAD that is the disk, inside a throwaway clone.

### Location

`fs.mkdtempSync` under `os.tmpdir()`, prefix `debate-review-local-`. All git objects created for the snapshot live only there.

### Clone-side git isolation

Discovery against `repoDir` (`rev-parse`, `status`, `ls-files`) is read-only and uses the user's config, so index flags and sparse state are visible.

Every git command whose cwd is the temp clone (`clone` after it exists, `checkout`, `add`, `commit`, `diff`) runs isolated from the user's git config:

- `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` empty (or pointed at a missing file)
- `-c core.hooksPath=<empty directory inside tmp>`
- `-c core.fsmonitor=false`
- `-c commit.gpgSign=false`
- `git commit --no-verify`

Never write configuration, refs, or hooks in `repoDir`. Relays keep the existing ambient environment; do not special-case them for local mode.

The overlay copies raw bytes from disk. It does not run clean or smudge filters on the way in. Isolated `git add` in the clone records those bytes.

### Steps

1. Resolve `repoDir`: `--repo-dir` if given, else `git rev-parse --show-toplevel` from cwd. Fail if not a git work tree, or if `HEAD` does not resolve (no commits).
2. Fail if `git ls-files -u` is non-empty: "cannot snapshot a conflicted working tree".
3. Fail closed on hidden index bits: if `git ls-files -v -z` reports `S` / `s` (skip-worktree) or any lowercase status tag (assume-unchanged), error with a specific message naming the feature. Sparse-checkout is unsupported for the same reason (skipped paths look like deletions).
4. Resolve base (see below).
5. `git clone --local --no-checkout <repoDir> <tmp>` under clone-side isolation. Do not pass `--recurse-submodules`. If `.gitmodules` exists in `repoDir`, log a warning that submodule dirty state is not in the snapshot, and continue.
6. `git -C <tmp> checkout --detach <user HEAD sha>` under isolation.
7. Fast path: if `git -C <repoDir> status --porcelain` is empty, skip overlay and the extra commit. `HEAD` in the clone is the user's `HEAD`. Diff is still `<base>...<HEAD>`, so branch commits versus the base are reviewed. Hidden-bit failure already ran, so this porcelain check is trustworthy.
8. Otherwise overlay, then maybe snapshot-commit, only in the clone.

   **Snapshot path set** = `git -C <repoDir> ls-files -z -co --exclude-standard`.

   **Gitlink set** = paths whose index mode is `160000` in `repoDir` or in the clone. Exclude them from overlay and from pruning. Leave the user-HEAD gitlink in the clone. Warn once.

   **Prune first** (before any copy), deepest path first:

   - Every clone-index path that is not in the snapshot set and not a gitlink: remove the clone leaf without following it (`lstat` / `unlink` / `rmdir`, never `realpath` through a symlink). Then drop empty parent directories the same way.
   - That is what makes `git rm` and file↔directory replacements safe. Copy-then-prune is forbidden: if HEAD had symlink `a → /tmp/x` and disk now has `a/b`, copying first writes through the old symlink outside the clone.

   **Then place** each remaining snapshot path (not a gitlink):

   - Never follow a clone-side symlink when creating parent directories.
   - If an incompatible leaf already exists at the destination (symlink vs directory vs file, or a case-different sibling on a case-insensitive volume), remove that leaf without following it, then place the new one.
   - If the source exists on disk in `repoDir`: copy a regular file (content plus executable bits from source `lstat`; do not fail the run when the destination filesystem cannot store Unix `100755`), or recreate a symlink. Reject special files (fifo, socket, device) with a specific error.
   - If the source does not exist on disk (tracked, deleted in the worktree, still in the index): delete the clone leaf if present, without following it.

   Then, only in the clone, under isolation:

   ```text
   git add -A
   ```

   If `git diff --cached --quiet HEAD` succeeds, skip the snapshot commit and use the clone's `HEAD` as on the fast path. Do not use `status --porcelain` for this decision; it is the index vs HEAD that matters, and it is how leftover gitlinks avoid a failing empty commit.

   Otherwise:

   ```text
   git -c user.name=debate-review -c user.email=debate-review@local commit --no-verify -m "debate-review local snapshot"
   ```

   Do not `--allow-empty`. If `git commit` refuses, fail.

9. Three-dot diff in the clone: `git diff <baseSha>...<snapshotSha>`. Use the sha resolved in `repoDir`, not a ref name that might mean something else inside the clone. Empty diff → same error as today (`empty diff, nothing to review`).
10. Dispatch: `resolveRole` with `cwd: repoDir` (project `.delegate/config.json` and global lanes). Relays with `cwd: tmp` (`--cd` the snapshot). These directories are intentionally different. `findClone`, `git fetch`, and `worktree add` on the user's repo are skipped.
11. Print the review in the same format as `--dry-run` (`===== REVIEW BODY =====` and one block per inline comment). Never call `postReview`, `alreadyReviewed`, or `fetchSpec`. Do not build a fake forge target and hope those helpers no-op.

### Cleanup

`try/finally`, including failures after the clone exists:

- Default: `fs.rmSync(tmp, { recursive: true, force: true })`.
- `--keep`: do not delete; log the absolute path.

After a default run the user's `git status`, `git worktree list`, and refs are indistinguishable from before the run (aside from the review artifacts under `~/.cache/debate-review/`, which already exist for forge runs). `clone --local` hardlinks existing objects; new objects live only in the clone; deleting the clone unlinks those hardlinks and does not drop source object names.

### Disk wins

The snapshot follows the worktree, not the index. A change that is staged and then reverted on disk is not in the snapshot. Untracked files that are not ignored are in. Ignored files are not. Gitlinks are the exception: they stay at user HEAD.

## Base

`--base` already exists. Local default when it is omitted, first match that `git rev-parse --verify` accepts in `repoDir`:

1. The commit `refs/remotes/origin/HEAD` points at (`git symbolic-ref -q refs/remotes/origin/HEAD`, then `rev-parse`).
2. `main`
3. `master`

If none resolve: fail with "cannot resolve a base branch; pass --base".

The brief's `{{BASE}}` is the resolved sha, matching today's use of `pr.baseSha`. After `git clone --local`, the clone's `origin` is the local path; the sha still exists as an object because the clone hardlinked the source object store.

## What the reviewers get

`pr`-shaped object (so the rest of `review-pr.mjs` stays one pipeline):

| Field | Local value |
| --- | --- |
| `title` | Current branch short name, or `HEAD` if detached |
| `body` | `git log --oneline <baseSha>..HEAD` from the user repo (commits only), then a blank line, then `Snapshot includes uncommitted and untracked files (respecting .gitignore).` Omit that second sentence when no snapshot commit was made. |
| `url` | empty string |
| `head` | Snapshot commit sha in the clone (user `HEAD` when no snapshot commit was made) |
| `headRef` | Same as `title` |
| `baseRef` | The ref name that resolved (e.g. `origin/main`, `main`) |
| `baseSha` | Resolved sha |
| `fetchRef` | `null` |
| `local` | `true` |

`{{SPEC}}` is the existing skip string: `none found, skip the Spec axis`. Do not parse `#N` against the forge.

`findStandards` runs against the clone after overlay, so an untracked `AGENTS.md` on disk is visible.

No prompt addendum for untracked files: after a snapshot commit they are ordinary files in `HEAD`, and `review-main.md` already points at `git diff {{BASE}}...{{HEAD}}`.

## Artifacts

`~/.cache/debate-review/local/<repo>/<branch>/<head12>/`

- `<repo>` is the basename of `repoDir`.
- `<branch>` is the branch short name with `/` replaced by `__`, or `HEAD`.
- `<head12>` is the first 12 characters of `pr.head`.

`--out-dir` still overrides. `run.json` records `local: true`, `repoDir`, base name/sha, whether a snapshot commit was made, and the temp clone path (even if later deleted). Do not key artifacts off a forge `target.owner` / `target.number`.

## Code shape

New file: `skills/debate-review/scripts/lib/local.mjs`.

Exported functions:

- `resolveBase(repoDir, override) → { name, sha }`
- `isClean(repoDir) → boolean` (`status --porcelain` empty; caller has already fail-closed on hidden index bits)
- `hasUnmerged(repoDir) → boolean`
- `hasHiddenIndexBits(repoDir) → boolean` (`ls-files -v` skip-worktree or assume-unchanged)
- `snapshotWorkingTree(repoDir, { keep, base }) → { dir, pr, cleanup }` where `base` is the `--base` override (or omitted), and `cleanup()` deletes `dir` unless `keep`

`review-pr.mjs` branches only at source resolution, role cwd vs relay cwd, and at post-vs-print. After a `pr` object and a directory exist, the brief, dispatch, validate, anchor, and render path is shared. Local print uses the same branch as `--dry-run`; a naive `opts.local` must not fall through to `postReview`.

Do not add a second script.

## Agent skill and README

`skills/debate-review/SKILL.md`: if the user wants a review and there is no PR/MR URL, run `--local` from the repo (or `--repo-dir`). Do not invent a URL. Relay stdout. `--dry-run` stays the print-only forge path.

`README.md`: short "Local preview" section with the two-flag table. The existing "Run it by hand" `--dry-run` line stays; add a `--local` line next to it.

## Tests

No live relays, no network.

Usage (`test/review-pr.test.mjs`), by spawning the script (do not `import` `review-pr.mjs` to reach `parseArgs`; `main()` runs on import):

- `--local` with a positional argument exits 2
- `--dry-run` with no positional argument exits 2
- `--local --dry-run` exits 2
- `--local --repo-dir <non-repo>` exits 1: parsing accepted no positional, then snapshot failed before any relay

`local.mjs` against fixture repos in `os.tmpdir()`:

- `resolveBase`: `--base` wins; else `origin/HEAD`; else `main`; else `master`; else throw
- Overlay: modified tracked file, deleted tracked file, `git rm`'d file, untracked file, gitignored file (absent from the snapshot tree)
- Overlay: symlink at HEAD replaced by a directory on disk (C1; clone must not write through the old symlink)
- Overlay: `100644` ↔ `100755` mode-only change is in the snapshot tree (C6)
- Overlay: gitlink paths are unchanged from user HEAD and do not fail the copy (C2)
- Fast path: clean feature branch versus `main` produces a clone whose `HEAD` equals the user's `HEAD` and whose diff versus `main` is the branch
- Conflicted worktree throws
- Skip-worktree or assume-unchanged worktree throws the hidden-bit error (C3)
- After `snapshotWorkingTree` with `keep: false`, `cleanup()` removes the temp dir, including when overlay throws after the clone exists
- The user's `HEAD`, index, and `git worktree list` are unchanged after snapshot + cleanup

Do not require a full `git fsck` in CI. Isolation is the clone-in-tmpdir plus the HEAD/index/worktree-list checks.

## Implementation order

1. Usage parsing and spawn tests (fail closed on the illegal combinations; `--local --repo-dir <non-repo>` exits 1).
2. `local.mjs` + fixture tests for base, hidden bits, overlay (including C1/C2/C6), fast path, cleanup.
3. Wire `--local` into `review-pr.mjs`: skip forge, `resolveRole` from `repoDir`, relays in `tmp`, always print, `finally` cleanup.
4. SKILL.md and README.
