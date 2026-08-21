---
name: debate-review
description: Two-model debate review of a GitHub PR or GitLab MR, posted as inline comments. Use for any PR/MR review request.
license: MIT
compatibility: Requires Node 18+, `gh` (GitHub) or `glab` (GitLab) authenticated, and delegate-skills installed for the main/debate lanes.
metadata:
  version: 0.1.0
---

# debate-review

Two models argue before anything is posted. A main reviewer finds issues. A debate reviewer tries to
knock them down and may add its own. The main reviewer then makes the final call, and one review with
inline comments lands on the PR or MR. It posts from the user's own `gh` or `glab` account as a
`COMMENT` review. It never approves and never requests changes.

You are the orchestrator. You run one command and relay the result. You do not review the diff
yourself, and you do not touch the PR.

## Run it

```bash
node "<skill-dir>/scripts/review-pr.mjs" <pr-url | number> [--dry-run]
```

- `<pr-url>` is a GitHub `/pull/N` or GitLab `/-/merge_requests/N` URL. A bare number resolves against
  the cwd's `origin`.
- The reviewers are two delegate-skills lanes, `review-main` and `review-debate`. If either is missing
  the script says so. Add them with `delegate-setup`. Pick two different implementers, since the debate
  is only worth something when the second model doesn't share the first one's blind spots (main
  `claude` or `grok`, debate `codex` at high effort is a good pair). For a one-off, pass
  `--main <implementer>` or `--debate <implementer>`. Only implementers whose relay has `--read-only`
  are accepted. These two lanes belong to the reviewer. Don't point them at a lane you use for other
  work, such as a plan-debate lane.
- `--dry-run` prints the review instead of posting it. Use it when the user wants to see the review
  before it lands.
- Exit code `3` means this head sha already has a debate-review. Re-run with `--force` to post again.
- A run takes minutes, since it is two or three implementer sessions back to back. Run it in the
  background and report the printed URL when it finishes. Don't poll tightly.

All flags: `--help`. Contracts: [references/schema.md](references/schema.md). What gets posted:
[references/comment-format.md](references/comment-format.md). The reviewer briefs live in `assets/prompts/`
and the script fills them in; you don't need to read them.

## After it posts

Each posted comment carries a `<!-- debate-review:<id> status=... -->` marker. `babysit-pr` recognises
the marker and handles the round like any other bot round (verify, fix blockers, reply in the thread,
resolve). Don't act on the findings yourself unless the user asks.

## Artifacts

`~/.cache/debate-review/<owner>__<repo>/<N>/<head>/` holds `run.json` (all three documents, timings,
what was posted) plus `main/`, `debate/`, and `final/`, each with the brief sent and the relay's
`result.json`.
