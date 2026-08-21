---
name: debate-review
description: >-
  Review a GitHub pull request or GitLab merge request and post the findings as a review with inline
  comments. Use when the user asks to review a PR/MR, run debate-review, or right after an
  orchestrator opens a PR. Not for local uncommitted diffs.
license: MIT
compatibility: Requires Node 18+, `gh` (GitHub) or `glab` (GitLab) authenticated, and delegate-skills installed for the main/debate lanes.
metadata:
  version: 0.1.0
---

# debate-review

Two models debate before anything is posted. A **main** reviewer finds issues, a **debate** reviewer
attacks them and adds its own, main makes the final call, and one review with inline comments lands on
the PR/MR — from the user's own `gh`/`glab` account, event `COMMENT` (never approve / request changes).

You are the **orchestrator**. You run one command and relay the result; you do not review the diff
yourself and you do not touch the PR.

## Run it

```bash
node "<skill-dir>/scripts/review-pr.mjs" <pr-url | number> [--dry-run]
```

- `<pr-url>` is a GitHub `/pull/N` or GitLab `/-/merge_requests/N` URL; a bare number resolves against
  the cwd's `origin`.
- Reviewers come from two delegate-skills fleet lanes: **`review-main`** and **`review-debate`**. If they
  are missing, the script says so — add them with `delegate-setup` (pick two *different* implementers;
  debate is strongest when heterogeneous, e.g. main `claude`/`grok`, debate `codex` at high effort), or
  pass `--main <implementer>` / `--debate <implementer>` for a one-off. Only implementers whose relay has
  `--read-only` are accepted. These lanes are the reviewer's own; they do not reuse any lane you keep for
  other work (a plan-debate lane, a tests lane…).
- `--dry-run` prints the review instead of posting. Use it when the user wants to see before it lands.
- Exit `3` means this head sha already has a debate-review (re-run with `--force` to post again).
- Runs take minutes (two or three implementer sessions). Run it in the background and report the
  printed URL when it finishes; do not poll tightly.

Full flags: `--help`. Contracts: [references/schema.md](references/schema.md). What gets posted:
[references/comment-format.md](references/comment-format.md). Prompts: `prompts/`.

## After it posts

The review's comments carry `<!-- debate-review:<id> status=… -->` markers. `babysit-pr` recognises
those and handles them like any other bot round (verify, fix blockers, reply in-thread, resolve).
Don't act on the findings yourself unless the user asks.

## Artifacts

`~/.cache/debate-review/<owner>__<repo>/<N>/<head>/` — `run.json` (all three documents, timings,
what was posted), plus `main/`, `debate/`, `final/` with each brief and relay `result.json`.
