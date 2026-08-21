# review-skills

Skills that review pull/merge requests with **two models debating** before anything is posted.
Sibling of `delegate-skills` (dispatch) and `guard-skills` (review lenses). Consumes both.

| Skill | Job |
| --- | --- |
| [`debate-review`](skills/debate-review/SKILL.md) | Main reviewer reviews the PR → debate reviewer attacks the findings and adds its own → main makes the final call → one review with inline comments is posted. |

```bash
npx skills add amElnagdy/review-skills          # once published
node ~/.agents/skills/debate-review/scripts/review-pr.mjs <pr-url> --dry-run
```

Reviewers are two delegate-skills **lanes** of their own (`review-main`, `review-debate`), dispatched read-only through
the existing `*-delegate` relays. Nothing here edits code, commits, or approves a PR.

## Development

```bash
node --test test/
```
