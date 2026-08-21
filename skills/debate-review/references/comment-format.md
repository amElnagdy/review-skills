# What gets posted

One **review** per head SHA (never per finding), event `COMMENT` — it must not approve or request
changes on the author's behalf. Inline comments anchor to `line_start`–`line_end` on the new side.

## Review body

```
<!-- debate-review head=<sha> main=<implementer> debate=<implementer> agreed=<n> contested=<m> -->
**debate-review** · main: `<implementer>` · debate: `<implementer>` · <n> agreed · <m> contested

<final.summary>
```

## Inline comment

```
<!-- debate-review:<id> status=<agreed|contested> severity=<blocking|non-blocking> -->
**<blocking|non-blocking> · <agreed|contested>** — <claim>

<evidence>

Suggested: <recommendation>

_<debate_note>_
```

## Why the HTML markers

- `babysit-pr` finds our threads by the `<!-- debate-review` marker, not by a `[bot]` author — the
  review is posted from the user's own account.
- `head=<sha>` lets a re-run detect an existing review for this push and skip (or `--force`).
- Every reply in-thread keeps babysit-pr's attribution line: `I am <model-slug> writing on behalf of <user>.`
