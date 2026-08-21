# What gets posted

One review per head sha, never one per finding. The review event is `COMMENT`, so it cannot approve
or request changes on the author's behalf. Inline comments anchor to `line_start` through `line_end`
on the new side of the diff.

## Review body

```
<!-- debate-review head=<sha> main=<implementer> debate=<implementer> agreed=<n> contested=<m> -->
**debate-review** main `<implementer>`, debate `<implementer>`. <n> agreed, <m> contested.

<final.summary>
```

## Inline comment

```
<!-- debate-review:<id> status=<agreed|contested> severity=<blocking|non-blocking> -->
**<blocking|non-blocking>, <agreed|contested>.** <claim>

<evidence>

Suggested: <recommendation>

_<debate_note>_
```

## Why the HTML markers

- `babysit-pr` finds these threads by the `<!-- debate-review` marker, not by a `[bot]` author. The
  review is posted from the user's own account, so there is no bot author to match on.
- `head=<sha>` lets a re-run detect that this push already has a review and skip it (or `--force`).
- Replies inside a thread keep babysit-pr's attribution line: `I am <model-slug> writing on behalf of <user>.`
