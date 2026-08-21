# debate-review JSON contracts

Three documents flow through one run. Each implementer returns its document as the **only** fenced
```json block in its final message; the script extracts it and validates the `schema` id.

## 1. `debate-review.findings.v1` — main reviewer → script

```json
{
  "schema": "debate-review.findings.v1",
  "head": "<head sha reviewed>",
  "verdict": "approve | needs-attention",
  "summary": "one-paragraph ship/no-ship read",
  "findings": [
    {
      "id": "F1",
      "file": "src/foo.py",
      "line_start": 42,
      "line_end": 48,
      "severity": "blocking | non-blocking",
      "axis": "correctness | security | spec | standards | tests | docs",
      "claim": "what is wrong, one sentence",
      "evidence": "why — code path, quoted line, spec line",
      "recommendation": "concrete change",
      "confidence": 0.0
    }
  ]
}
```

- `id`: `F<n>` for main, `D<n>` for findings the debate reviewer adds.
- `line_start`/`line_end` must be lines **in the PR diff's new side** (GitHub/GitLab can only anchor there).
  If the problem is outside the diff, anchor to the nearest changed line and say so in `evidence`.
- `severity` follows babysit-pr: **blocking** = ships a defect / security / data / spec violation /
  migration hazard / failing check. Everything else is non-blocking.
- `confidence` 0–1, honest. Findings under `min_confidence` (default 0.5) are dropped before debate.

## 2. `debate-review.debate.v1` — debate reviewer → script

```json
{
  "schema": "debate-review.debate.v1",
  "head": "<same sha>",
  "verdicts": [
    { "id": "F1", "verdict": "confirm | refute | downgrade", "reason": "one sentence", "evidence": "file:line or quoted code" }
  ],
  "new_findings": [ /* same shape as findings[], ids D1, D2, … */ ]
}
```

- Every `F*` id gets exactly one verdict. Missing id = treated as `confirm` with reason "no objection".
- `downgrade` = real but not blocking (severity → non-blocking), or confidence should drop.
- `refute` must carry evidence. A bare "I disagree" is recorded but weighted as `downgrade`.

## 3. `debate-review.final.v1` — main reviewer (rebuttal pass) → script → PR

```json
{
  "schema": "debate-review.final.v1",
  "head": "<same sha>",
  "summary": "final ship/no-ship read after debate",
  "findings": [
    {
      "id": "F1",
      "status": "agreed | contested | withdrawn",
      "severity": "blocking | non-blocking",
      "file": "…", "line_start": 0, "line_end": 0,
      "claim": "…", "evidence": "…", "recommendation": "…",
      "debate_note": "one line: what debate said and why main kept/dropped/changed it"
    }
  ]
}
```

- `agreed`: both models stand behind it → posted normally.
- `contested`: debate refuted, main holds with evidence → posted with a `contested` tag (or dropped,
  `--contested drop`).
- `withdrawn`: main accepts the refutation → never posted, kept in the run log.
- `D*` findings: main must `agree` or `withdraw` them too; a `D*` main rejects with evidence is
  `contested` (debate's claim, main's objection in `debate_note`).

## Run log

`<out-dir>/run.json` keeps all three documents plus timings, implementers, lanes, and the posted
comment ids, keyed by `owner/repo#N@head`. Re-running on the same head is a no-op unless `--force`.
