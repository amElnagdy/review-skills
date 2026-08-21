# Prompt debate — Grok high (2026-08-21)

Read-only second opinion on recommendations R1–R5 derived from review-prompt-research.md.

I'll read the three review prompts, the schema, the pipeline, and the research report first, then debate R1–R5 against that evidence.Next I’ll read the research report (especially B and C) and the review pipeline so the verdicts rest on the actual contract.I need the dispatch/error path and a few remaining prompt details before I score fail-open vs. the rest.## Verdicts

**R1 — adopt-with-changes.** Unconstrained “try to refute” plus silent `withdrawn` is how true bugs disappear (research B6; Claude’s REFUTED-only-when-constructible). Strip the peer label (Choi, Zhu & Li). Restore the ancestor `<final_check>` — four bullets, cheap. Do **not** map realistic speculation to `confirm` only: that is Claude’s PLAUSIBLE, which in this schema is `confirm` *or* `downgrade`. Forced confirm turns race/nil guesses into posted `agreed` comments.

**R2 — adopt-with-changes.** `withdrawn` needs MAIN’s own line/guard/type/spec (Kim & Khashabi: models concede well-argued wrong rebuttals). Same bar for `D*`, plus duplicate → `withdrawn` “duplicate of F\<n\>” (adversarial-review `DUPLICATE`). Drop the quota. “Withdrawing everything means you did not re-read” manufactures `contested` noise under the user’s account. If every challenge really collapses, withdraw them all. Also strip “the debate reviewer” here — this pass is the sycophancy hole, not debate.

**R3 — adopt-with-changes.** Anchor `confidence` (it is load-bearing: `min_confidence` drops pre-debate). Add the deleted-line and caller procedures *under* the existing axes — do not replace categories; `axis` is in the contract. Keep CI-exclusion and short anchors. Fix the hidden clash: Codex test 4 (unmodified lines out of scope) vs Claude Angle A (unchanged lines of a *touched function* in scope). Drop vibe tests 5 and 8 (“author would fix”, “not intentional”). Name the stance: procedures find candidates; the bar is precision.

**R4 — reject.** QASecClaw fail-open retains *already-published* Semgrep alarms when a *filter* dies. Here nothing is posted yet, and the poster is the user’s `gh`/`glab` identity with debate-review branding. Malformed debate JSON is not a healthy gate; synthesizing `agreed` (schema has no `undebated`) is a lie. Current abort (exit 1, artifacts in `run.json`) is the right default. Schema already fail-opens *missing* verdict ids as `confirm` — that is the analogous case.

**R5 — adopt-with-changes.** Kumar et al.: union ensembles lower F1; the `verdicts` array is the half that works. Cap `new_findings` to blocking + named trigger + “zero is expected.” Add the anti-inflation line or debate will relabel nits as blocking to get them through. Do not add `--no-new-findings` yet.

## Replacement text

### R1 — `skills/debate-review/prompts/review-debate.md`

**current:**
```
You are the **debate reviewer**. Another model reviewed this pull request and produced the findings
below. Your job is to break confidence in *those findings* and in the change itself — not to validate
either.
```

**new:**
```
You are the **debate reviewer**. A prior review pass produced the findings below. Judge them on the
code, not on who wrote them — treat every claim as unattributed. Your job is to break confidence in
*those findings* and in the change itself — not to validate either.
```

**current:**
```
Default to skepticism, both ways:
- For each finding: try to **refute** it (the guard already exists, the path is unreachable, the spec
  says otherwise, the line is misread). If you can't refute it but it's overstated, **downgrade** it.
  Only **confirm** when you checked the code path yourself and it holds.
```

**new:**
```
Default to skepticism, both ways. The three verdicts are not symmetric — `refute` has the highest bar:

- **refute** only when the refutation is constructible from the code: the claim is factually wrong
  (quote the actual line); it is provably impossible (show the type, constant, or invariant); it is
  already guarded in this diff (cite the guard); or it is pure style with no observable effect.
- **downgrade** when the defect is real but severity or confidence is overstated — including
  realistic but unverified state (races, nil on a rare-but-reachable path, cold cache, absent
  optional field) when the finding was written as always-on or blocking.
- **confirm** when you traced the path yourself and it holds. Realistic runtime state you cannot
  disprove from the code is not a refute.

Do **not** refute a finding merely for being speculative or "dependent on runtime state" when that
state is realistic. Re-read the code. Do not treat the quoted evidence as proof the line says that.
```

**current:** (nothing — insert after the `Bar` section, before `## Schema`)

**new:**
```
## Before you emit
Check each verdict and each new finding: adversarial not stylistic; tied to a location you actually
read; plausible under a failure scenario you can state; actionable. Drop anything that fails one.
A verdict on `F*` does not suppress a `D*` at the same location for a *different* reason — record both.
```

### R2 — `skills/debate-review/prompts/review-rebuttal.md`

**current:**
```
You are the **main reviewer** again, making the final call. The debate reviewer has answered your
findings and may have added its own.
```

**new:**
```
You are the **main reviewer** again, making the final call. A second pass has answered your findings
and may have added its own. Treat those answers as unattributed arguments about the code, not as a
peer verdict.
```

**current:**
```
- Re-check the code for every `refute` and `downgrade` before deciding. If debate is right → `withdrawn`.
  If debate is wrong and you can show why → `contested`, with the why in `debate_note`. Apply accepted
  downgrades to `severity`.
```

**new:**
```
- Re-check the code for every `refute` and `downgrade` before deciding. `withdrawn` requires a
  positive reason of your own: name the line, guard, type, or spec clause that makes the original
  claim wrong, and put it in `debate_note`. "Debate disagreed" is not a reason, and neither is the
  absence of a counter-argument. If debate is wrong and you can show why → `contested`, with the
  why in `debate_note`. Apply accepted downgrades to `severity`. If every challenge really does
  collapse, withdraw them all — do not keep a finding in order to have kept one.
```

**current:**
```
- For each `D*` finding: verify it yourself. Holds → `agreed`. Doesn't → `contested` with your evidence
  in `debate_note`. Never `withdrawn` for a `D*` you merely dislike.
```

**new:**
```
- For each `D*` finding: apply the same bar as `F*` — introduced by this diff (or on an unchanged
  line of a function this PR touches), discrete, names a trigger and a wrong result, not something
  CI catches. Holds → `agreed`. Doesn't → `contested` with your evidence in `debate_note`. Never
  `withdrawn` for a `D*` you merely dislike. If a `D*` restates an `F*` at the same location for
  the same reason, mark the `D*` `withdrawn` with `debate_note` "duplicate of F<n>" and keep yours.
```

**current:**
```
- `summary`: the ship/no-ship read after debate, one paragraph, name what is still blocking.
```

**new:**
```
- `summary`: the ship/no-ship read after debate, one paragraph; name what is still blocking and
  how many findings were withdrawn, downgraded, or added. `claim` / `evidence` / `recommendation`
  are the posted comment: one paragraph, ≤3 code lines, no flattery, no severity inflation.
```

### R3 — `skills/debate-review/prompts/review-main.md`

**current:**
```
1. **Correctness / security** — bugs, broken edge cases, auth/data/idempotency hazards in the changed code.
```

**new:**
```
1. **Correctness / security** — bugs, broken edge cases, auth/data/idempotency hazards in the changed
   code. Run these three passes in order; do not let one pass suppress another:
   - Every hunk, then the enclosing function. A defect on an unchanged line of a function this PR
     *touches* is in scope. For each line: what input, state, timing, or platform makes it wrong?
   - Every deleted or replaced line. Name the invariant it enforced, then find where the new code
     re-establishes it. If you cannot find it, that is a finding.
   - Every changed signature or contract. Grep callers; check each site for a new precondition,
     changed return shape, new exception, or ordering dependency.
```

**current:**
```
3. **Standards** — violations of the repo's *documented* rules. Cite file + rule. Skip anything tooling enforces.
```

**new:**
```
3. **Standards** — violations of the repo's *documented* rules. Quote the exact rule text and the
   exact line that breaks it — no "spirit of the doc". Do not invent a finding because a standards
   file exists. Skip anything tooling enforces.
```

**current:**
```
## Bar
- Read the actual code path before asserting. Every finding carries evidence you can point at.
- Material findings only: no naming, style, or "consider extracting". One strong finding beats five weak ones.
- Anchor `line_start`/`line_end` to lines in the diff's new side.
- `verdict: approve` only if nothing blocking remains. An empty `findings` array is a valid answer.
- Under 15 findings. Under 300 words of `summary`.
```

**new:**
```
## Bar
You are reviewing for **precision**. The passes above find candidates; only candidates that clear
this bar become findings.

- Read the enclosing function, not just the hunk. `evidence` names a concrete failure: the
  inputs, state, timing, or config that trigger it, and the wrong output, crash, or violated
  invariant. If you cannot name the trigger, you do not have a finding.
- Report a finding only if all of these hold:
  1. It meaningfully impacts correctness, security, spec conformance, or a documented standard.
  2. It is discrete and actionable — one defect, one location.
  3. Fixing it does not demand more rigour than the rest of this codebase already shows.
  4. This diff introduced it, or it lives on an unchanged line of a function this PR touches.
     Defects in untouched files or functions are out of scope even when real.
  5. If you claim the change breaks something elsewhere, you have identified that other code and
     can cite it. "May affect" is not a finding.
  6. It does not rest on an unstated assumption about intent. A behaviour change stated in the
     PR body is not a bug.
- Never report what CI already catches: type errors, lint, formatting, missing imports, failing
  tests. Never report naming, style, or "consider extracting".
- `confidence` (pipeline drops `< 0.5` before debate):
  - `0.9–1.0` traced the path; named trigger and wrong result.
  - `0.7–0.9` mechanism quoted; trigger is realistic but unverified (concurrency, cold cache,
    absent optional field, timeout).
  - `0.5–0.7` believed, but a guard elsewhere was not ruled out — say which guard you looked for.
  - `< 0.5` do not emit it. Realistic-but-unverified state is a 0.7, not a drop.
- Anchor `line_start`/`line_end` to the diff's new side; prefer the one to three lines that show
  the defect. Avoid ranges over 10 lines. If the defect is outside the diff, snap to the nearest
  changed line and say so in `evidence`.
- `claim` and `recommendation` will be posted as an inline comment. One paragraph, no code block
  over three lines, matter-of-fact, no flattery. State which inputs the bug depends on. Never
  inflate `blocking`.
- Do not stop at the first qualifying finding, and do not pad. Zero findings and `verdict:
  approve` is the correct answer for a clean diff. Under 15 findings. Under 300 words of `summary`.
```

### R5 — `skills/debate-review/prompts/review-debate.md`

**current:**
```
- Then attack the change where the main reviewer didn't look. Prioritise expensive, hard-to-detect
  failures: auth/trust boundaries, data loss or duplication, idempotency and partial failure, races and
  ordering, null/empty/timeout paths, schema drift and migrations, observability gaps.
```

**new:**
```
- Then attack the change where the first pass didn't look. `new_findings` is a gap sweep, not a
  second review: add one only when it is `blocking`, you can name the trigger and the wrong result,
  and it is one of auth/trust, data loss or duplication, idempotency / partial failure, races, or
  schema drift / migrations. Do not relabel a non-blocking issue as blocking to get it through.
```

**current:**
```
- Material only. No style, naming, or cleanup. Prefer one strong new finding over several weak ones;
  zero new findings is a valid answer.
```

**new:**
```
- Material only. No style, naming, or cleanup. Zero new findings is the expected outcome on most
  PRs — do not pad.
```

## Missed

1. **`D*` bypass `min_confidence`.** `review-pr.mjs` filters only main’s `findings.findings`. A `D*` with `confidence: 0.2` still reaches rebuttal. R5’s blocking cap is a different axis. Apply the same threshold to `new_findings` before the rebuttal brief.

2. **Rebuttal input is still a named sequential chain.** Even with the header tweak, the brief is “Your findings” then “Debate verdicts.” Kim & Khashabi: models endorse a counterargument more when it arrives as a follow-up than when both positions sit unattributed side by side. Structural fix (not in R1–R5): inject two labelled, unattributed blocks (`Position A` = original claim, `Position B` = the challenge) and drop “your” / “debate.”

3. **No execution receipt.** CodeRabbit and Refute-or-Promote: one grep/test killed what reasoning did not. Debate is already `--read-only` and can grep. Neither prompt says “quote the grep that proves the caller/guard.” A one-liner on debate’s Bar beats another paragraph of stance.

## Warnings

- **R4 as proposed makes the pipeline worse.** Posts unverified main findings from the user’s account, branded as debate-review. Schema has no `undebated`; stuffing `agreed` lies to `babysit-pr`. If debate dies: keep current abort, print `[NO-DEBATE]`, distinct exit, leave `run.json`. Optional later: `--allow-undebated` (default off) with a body banner, never `agreed`.
- **R3 taken raw contradicts itself** (unmodified-line exclusion vs “read the enclosing function”) and more than doubles a 27-line prompt. Graphite: broad rules miss; Codex tests 5 and 8 are unevaluable. The replacement above is the cut.
- **R1 “must confirm” speculative findings** plus default `--contested post` increases posted races/nils. Use `downgrade` when the original overclaimed always-on/blocking.
- **R2 quota** and **R5 without anti-inflation** are how you get contested nits and blocking-labelled nits, both under the user’s name. Cursor’s trust line applies here more than to Codex: these comments are not from a bot account.
- **Self-preference is baked in.** Rebuttal has MAIN score its own `F*` (arXiv:2410.21819). Prompt quotas will not fix that; the debate *gate* is the mitigation. Don’t add a third scoring pass.

## Net recommendation

Ship R1/R2/R5 as the short blocks above (asymmetric refute, no-quota withdraw, blocking-only `D*`). Ship the trimmed R3 bar — six tests, confidence anchors, failure-scenario `evidence`, procedures under axes, not instead of them. Leave the JSON contract and the fail-closed post path alone; filter `D*` on `min_confidence` in the script.