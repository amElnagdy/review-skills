---
name: debate-review
description: >-
  Review a GitHub pull request or GitLab merge request with two models that debate before posting:
  a main reviewer finds issues, a debate reviewer attacks them and adds its own, the main reviewer
  makes the final call, and one review with inline comments is posted. Use when the user asks to
  review a PR/MR with the debate reviewer, run debate-review, or right after a PR is opened by an
  orchestrator. Not for local uncommitted diffs.
license: MIT
compatibility: Requires Node 18+, `gh` (GitHub) or `glab` (GitLab) authenticated, and delegate-skills installed for the main/debate lanes.
metadata:
  version: 0.1.0
---

# debate-review

Phase 1 contract only. See `references/schema.md`, `references/comment-format.md`, `prompts/`.
Script and hook arrive in Phase 2–3.
