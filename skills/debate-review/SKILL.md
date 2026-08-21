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

Two models debate before anything is posted: a **main** reviewer finds issues, a **debate** reviewer
attacks them and adds its own, main makes the final call, and one review with inline comments lands on
the PR/MR. Implementers come from delegate-skills lanes (`review-main`, `review-debate`).

Phase 1 contract only. See `references/schema.md`, `references/comment-format.md`, `prompts/`.
Script and hook arrive in Phase 2–3.
