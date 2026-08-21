# What gets posted

One review per head sha, never one per finding. The review event is `COMMENT`, so it cannot approve
or request changes on the author's behalf. Inline comments anchor to `line_start` through `line_end`
on the new side of the diff.

## Levels

Severity is shown on the PR as a level, computed by the script from the contract's fields:

| Level | Meaning | Alert |
| --- | --- | --- |
| P0 | blocking on the security axis | `[!CAUTION]` (red) |
| P1 | any other blocking finding | `[!WARNING]` (yellow) |
| P2 | non-blocking | `[!NOTE]` (blue) |

GitHub and GitLab (17.10+) render those alert blockquotes with colour; anything else shows a plain
quote, which still reads.

## Review body

```
<!-- debate-review head=<sha> main=<implementer> debate=<implementer> agreed=<n> contested=<m> p0=<a> p1=<b> p2=<c> -->
| Level | Count |
| --- | ---: |
| P0 | <a> |
| P1 | <b> |
| P2 | <c> |
| contested | <m> |

**debate-review** on `<sha7>`, main `<implementer>`, second `<implementer>`.

<final.summary>
```

## Inline comment

```
<!-- debate-review:<id> status=<agreed|contested> severity=<blocking|non-blocking> level=<P0|P1|P2> -->
> [!CAUTION | WARNING | NOTE]
> **<level>, agreed by both reviewers.** <claim>

<evidence>

Suggested: <recommendation>

_<debate_note>_
```

A contested finding's first line reads `**<level>, contested. The second reviewer disagreed; the
main reviewer holds it, reasons below.** <claim>`.

## Why the HTML markers

- `babysit-pr` finds these threads by the `<!-- debate-review` marker, not by a `[bot]` author. The
  review is posted from the user's own account, so there is no bot author to match on.
- `head=<sha>` lets a re-run detect that this push already has a review and skip it (or `--force`).
- Replies inside a thread keep babysit-pr's attribution line: `I am <model-slug> writing on behalf of <user>.`
