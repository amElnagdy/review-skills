# Local debate-review

Date: 2026-08-25

`--dry-run` still needs a live GitHub PR or GitLab MR. It only skips the post. This spec adds `--local`: review the files on disk in the current repo, with no forge.

## Problem

`review-pr.mjs` starts by resolving a PR URL or number, calling `gh` or `glab`, fetching the head, and checking it out. There is no way to run the three-pass debate before a PR exists.

## Goal

From a git checkout, run the same debate against a snapshot of what is on disk (committed, uncommitted, and untracked, honoring `.gitignore`) versus a base branch. Print the review. Never talk to GitHub or GitLab. Leave the user's index, HEAD, refs, worktrees, and object database unchanged. Delete every temporary file the run created.

## Non-goals

- `babysit-pr` against a local review
- Posting a local review onto a PR opened later
- Overlaying submodule working trees
- Repos with no commits
- Including gitignored files
- Watching the working tree for changes during the run

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

### Steps

1. Resolve `repoDir`: `--repo-dir` if given, else `git rev-parse --show-toplevel` from cwd. Fail if not a git work tree, or if `HEAD` does not resolve (no commits).
2. Fail if `git ls-files -u` is non-empty: "cannot snapshot a conflicted working tree".
3. Resolve base (see below).
4. `git clone --local --no-checkout <repoDir> <tmp>`. Do not pass `--recurse-submodules`. If `.gitmodules` exists in `repoDir`, log a warning that submodule dirty state is not in the snapshot, and continue.
5. `git -C <tmp> checkout --detach <user HEAD sha>`.
6. Fast path: if `git -C <repoDir> status --porcelain` is empty, skip overlay and the extra commit. `HEAD` in the clone is the user's `HEAD`. Diff is still `<base>...<HEAD>`, so branch commits versus the base are reviewed.
7. Otherwise overlay, then snapshot-commit in the clone only:

   Snapshot path set = `git -C <repoDir> ls-files -z -co --exclude-standard`.

   For each snapshot path:

   - If the path exists on disk in `repoDir`, copy it into the clone (create parent dirs; preserve symlinks; do not follow them).
   - If it does not exist on disk (tracked, deleted in the worktree, still in the index), delete it in the clone if present.

   Then delete every path that is in the clone's index (`git -C <tmp> ls-files -z`) and not in the snapshot path set. That is what makes `git rm` disappear from the snapshot.

   Then, only in the clone:

   ```text
   git add -A
   ```

   If the clone is still clean (`status --porcelain` empty), skip the snapshot commit and use the clone's `HEAD` as on the fast path. That is how submodule-only dirt (not overlaid) avoids a failing empty commit.

   Otherwise:

   ```text
   git -c user.name=debate-review -c user.email=debate-review@local commit -m "debate-review local snapshot"
   ```

   Do not read or write the user's git config. Do not `--allow-empty`. If `git commit` refuses, fail.

8. Three-dot diff in the clone: `git diff <baseSha>...<snapshotSha>`. Empty diff → same error as today (`empty diff, nothing to review`).
9. Dispatch the three passes with `--cd` = the temp clone. `findClone`, `git fetch`, and `worktree add` on the user's repo are skipped.
10. Print the review in the same format as `--dry-run` (`===== REVIEW BODY =====` and one block per inline comment). Never call `postReview`. Never call `alreadyReviewed`. Never call `fetchSpec`.

### Cleanup

`try/finally`, including failures after the clone exists:

- Default: `fs.rmSync(tmp, { recursive: true, force: true })`.
- `--keep`: do not delete; log the absolute path.

After a default run the user's `git status`, `git worktree list`, and `git fsck --unreachable` are indistinguishable from before the run (aside from the review artifacts under `~/.cache/debate-review/`, which already exist for forge runs).

### Disk wins

The snapshot follows the worktree, not the index. A change that is staged and then reverted on disk is not in the snapshot. Untracked files that are not ignored are in. Ignored files are not.

## Base

`--base` already exists. Local default when it is omitted, first match that `git rev-parse --verify` accepts:

1. The commit `refs/remotes/origin/HEAD` points at (`git symbolic-ref -q refs/remotes/origin/HEAD`, then `rev-parse`).
2. `main`
3. `master`

If none resolve: fail with "cannot resolve a base branch; pass --base".

The brief's `{{BASE}}` is the resolved sha, matching today's use of `pr.baseSha`.

## What the reviewers get

`pr`-shaped object (so the rest of `review-pr.mjs` stays one pipeline):

| Field | Local value |
| --- | --- |
| `title` | Current branch short name, or `HEAD` if detached |
| `body` | `git log --oneline <baseSha>..HEAD` from the user repo (commits only), then a blank line, then `Snapshot includes uncommitted and untracked files (respecting .gitignore).` Omit that second sentence when no snapshot commit was made (clean worktree, or overlay left the clone clean). |
| `url` | empty string |
| `head` | Snapshot commit sha in the clone (user `HEAD` on the fast path) |
| `headRef` | Same as `title` |
| `baseRef` | The ref name that resolved (e.g. `origin/main`, `main`) |
| `baseSha` | Resolved sha |
| `fetchRef` | `null` |
| `local` | `true` |

`{{SPEC}}` is the existing skip string: `none found, skip the Spec axis`. Do not parse `#N` against the forge.

`findStandards` runs against the clone after overlay, so an untracked `AGENTS.md` on disk is visible.

## Artifacts

`~/.cache/debate-review/local/<repo>/<branch>/<head12>/`

- `<repo>` is the basename of `repoDir`.
- `<branch>` is the branch short name with `/` replaced by `__`, or `HEAD`.
- `<head12>` is the first 12 characters of `pr.head`.

`--out-dir` still overrides. `run.json` records `local: true`, `repoDir`, base name/sha, whether the fast path ran, and the temp clone path (even if later deleted).

## Code shape

New file: `skills/debate-review/scripts/lib/local.mjs`.

Exported functions:

- `resolveBase(repoDir, override) → { name, sha }`
- `isClean(repoDir) → boolean` (`status --porcelain` empty)
- `hasUnmerged(repoDir) → boolean`
- `snapshotWorkingTree(repoDir, { keep, base }) → { dir, pr, cleanup }` where `base` is the `--base` override (or omitted), and `cleanup()` deletes `dir` unless `keep`

`review-pr.mjs` branches only at source resolution and at post-vs-print. After a `pr` object and a directory exist, the brief, dispatch, validate, anchor, and render path is shared.

Do not add a second script.

## Agent skill and README

`skills/debate-review/SKILL.md`: if the user wants a review and there is no PR/MR URL, run `--local` from the repo (or `--repo-dir`). Do not invent a URL. Relay stdout. `--dry-run` stays the print-only forge path.

`README.md`: short "Local preview" section with the two-flag table. The existing "Run it by hand" `--dry-run` line stays; add a `--local` line next to it.

## Tests

No live relays, no network.

Usage (`test/review-pr.test.mjs`):

- `--local` with a positional argument exits 2
- `--dry-run` with no positional argument exits 2
- `--local --dry-run` exits 2
- `--local` with no positional argument is accepted by the parser (the test may stop before dispatch by asserting help/usage or by testing `parseArgs` once it is exported; do not require a full debate)

`local.mjs` against fixture repos in `os.tmpdir()`:

- `resolveBase`: `--base` wins; else `origin/HEAD`; else `main`; else `master`; else throw
- Overlay: modified tracked file, deleted tracked file, `git rm`'d file, untracked file, gitignored file (absent from the snapshot tree)
- Fast path: clean feature branch versus `main` produces a clone whose `HEAD` equals the user's `HEAD` and whose diff versus `main` is the branch
- Conflicted worktree throws
- After `snapshotWorkingTree` with `keep: false`, `cleanup()` removes the temp dir
- The user's `HEAD`, index, and `git worktree list` are unchanged after snapshot + cleanup

## Implementation order

1. Usage parsing and tests (fail closed on the illegal combinations).
2. `local.mjs` + fixture tests for base, overlay, fast path, cleanup.
3. Wire `--local` into `review-pr.mjs` (skip forge, always print, `finally` cleanup).
4. SKILL.md and README.
