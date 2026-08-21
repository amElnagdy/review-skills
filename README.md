# review-skills

Skills that review pull requests and merge requests. Two models argue over the findings before
anything is posted. Sibling of `delegate-skills` (which dispatches the models) and `guard-skills`
(review lenses). This repo uses both.

| Skill | Job |
| --- | --- |
| [`debate-review`](skills/debate-review/SKILL.md) | A main reviewer reads the PR. A debate reviewer tries to knock its findings down and may add its own. The main reviewer makes the final call. One review with inline comments is posted. |

```bash
npx skills add amElnagdy/review-skills          # once published
node ~/.agents/skills/debate-review/scripts/review-pr.mjs <pr-url> --dry-run
```

The two reviewers are delegate-skills lanes named `review-main` and `review-debate`, dispatched
read-only through the `*-delegate` relays you already have. Nothing in this repo edits code, commits,
or approves a PR.

## Development

```bash
node --test test/
```
