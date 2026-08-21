# Prompt debate — Codex gpt-5.6-sol xhigh (2026-08-21)

Read-only second opinion on recommendations R1–R5 derived from review-prompt-research.md.

## Verdicts

### R1: adopt-with-changes

For: Constrained refutation and anonymous attribution directly address the verification and identity-bias evidence in [§B6 and §B15](/Users/nagdy/LocalSites/skills/review-skills/docs/review-prompt-research.md:861). The final check is cheap and useful.  
Against: “Realistic speculation must be `confirm`” is too strong. The schema already makes `downgrade` appropriate when confidence is overstated.  
Verdict: Adopt the asymmetric bar, anonymity, and contract-safe self-check. Allow `downgrade`, never unsupported `refute`.

### R2: adopt-with-changes

For: Positive evidence for withdrawal counters sequential sycophancy; equal treatment and deduplication of `D*` findings close real gaps.  
Against: “Withdrawing everything means you did not re-read” imposes a quota. Every challenge might be correct, and forced resistance becomes a publicly posted `contested` false positive.  
Verdict: Require evidence for every withdrawal, but turn the quota into a re-check trigger.

### R3: adopt-with-changes

For: The eight tests, calibrated confidence, procedural passes, and comment rules are the best-supported prompt changes in [§A9](/Users/nagdy/LocalSites/skills/review-skills/docs/review-prompt-research.md:380) and [§B](/Users/nagdy/LocalSites/skills/review-skills/docs/review-prompt-research.md:826).  
Against: Replacing the axes would conflict with the schema’s `axis` field. An absolute ban on unchanged-line defects would also miss changed contracts breaking unchanged callers.  
Verdict: Keep the axes, add three compact procedures, and define scope causally: the diff must cause the defect.

### R4: reject

For: QASecClaw retained findings when its filter failed, avoiding silent recall loss.  
Against: It retained private analyzer alarms for human triage. This pipeline posts public comments under the user’s account. The schema has no `undebated` status, so fallback would mislabel findings as `agreed` or `contested`.  
Verdict: Posting must fail closed. Preserve artifacts and make any main-only posting an explicit future option.

### R5: adopt-with-changes

For: Two-model unions lowered F1 in every reported pairing, while second-model gates removed 79–98% of candidates or false positives.  
Against: A blocking-only rule can invite severity inflation and may suppress the rare independent catch.  
Verdict: Permit one narrow gap sweep, with the existing blocking definition, causal evidence, and zero as the stated default.

## Replacement text

### R1

[review-debate.md](/Users/nagdy/LocalSites/skills/review-skills/skills/debate-review/prompts/review-debate.md:1)

current:

````markdown
You are the **debate reviewer**. Another model reviewed this pull request and produced the findings
below. Your job is to break confidence in *those findings* and in the change itself — not to validate
either. You review; you never edit. Return exactly one fenced ```json block matching
`debate-review.debate.v1` and nothing else after it.
````

new:

````markdown
You are the **debate reviewer**. A prior review pass produced the findings below. Treat every claim as
unattributed and judge it from the repository. Your job is to challenge those findings and inspect the
change for missed defects. You review; you never edit. Return exactly one fenced ```json block matching
`debate-review.debate.v1` and nothing else after it.
````

current:

```markdown
## Stance
Default to skepticism, both ways:
- For each finding: try to **refute** it (the guard already exists, the path is unreachable, the spec
  says otherwise, the line is misread). If you can't refute it but it's overstated, **downgrade** it.
  Only **confirm** when you checked the code path yourself and it holds.
```

new:

```markdown
## Stance
Judge each finding independently. The verdicts are asymmetric; `refute` has the highest bar:

- `refute` only when the repository constructs the refutation: quote the line that makes the claim
  factually wrong; show the type, constant, or invariant that makes it impossible; cite the guard
  already handling it; or show that it has no observable effect.
- `downgrade` when the defect is real but its severity or confidence is overstated.
- `confirm` when you traced the path and the defect holds. A realistic but unverified trigger, such as
  concurrency, a cold cache, an absent optional field, a reachable null, timeout, retry, or partial
  failure, is not grounds to refute. Confirm it if the code admits the failure; downgrade it if only
  severity or confidence is overstated.
```

current:

```markdown
- New finding ids: `D1`, `D2`, … Same shape as the main findings.
```

new:

```markdown
- New finding ids: `D1`, `D2`, … Same shape as the main findings.

<final_check>
Before finalizing:
- For every verdict, cite the repository evidence that makes the verdict correct.
- For every new finding, check that it is adversarial rather than stylistic, tied to a code location
  you read, plausible under a concrete failure scenario, and actionable.
Re-read any verdict that fails the first check; every `F*` still needs a verdict. Drop any new finding
that fails the second.
</final_check>
```

### R2

[review-rebuttal.md](/Users/nagdy/LocalSites/skills/review-skills/skills/debate-review/prompts/review-rebuttal.md:11)

current:

```markdown
- Re-check the code for every `refute` and `downgrade` before deciding. If debate is right → `withdrawn`.
  If debate is wrong and you can show why → `contested`, with the why in `debate_note`. Apply accepted
  downgrades to `severity`.
- For each `D*` finding: verify it yourself. Holds → `agreed`. Doesn't → `contested` with your evidence
  in `debate_note`. Never `withdrawn` for a `D*` you merely dislike.
```

new:

```markdown
- Re-check the code for every `refute` and `downgrade`. `withdrawn` requires your own positive reason:
  name the line, guard, type, invariant, or spec clause that makes the original claim wrong, and put it
  in `debate_note`. The debate verdict and the absence of a counterargument are not reasons. If the
  challenge is wrong and you can show why, use `contested`. Accept a valid downgrade by changing
  `severity` and using `agreed`.
- If every challenged finding would be withdrawn, re-read them once more. Withdraw them all only if
  each independently meets the evidence bar above.
- For each `D*` finding, apply this full bar: the diff caused it; it is discrete and actionable;
  `evidence` names a trigger and wrong result; and configured CI would not already catch it. If it
  holds, use `agreed`. If it does not, use `contested` with your evidence in `debate_note`. If it
  duplicates an `F*` at the same location for the same failure scenario, mark the `D*` `withdrawn`
  with `duplicate of F<n>` in `debate_note`.
```

### R3

[review-main.md](/Users/nagdy/LocalSites/skills/review-skills/skills/debate-review/prompts/review-main.md:12)

current:

```markdown
1. **Correctness / security** — bugs, broken edge cases, auth/data/idempotency hazards in the changed code.
```

new:

```markdown
1. **Correctness / security** — bugs, broken edge cases, auth/data/idempotency hazards in the changed
   code. Run three passes:
   - Read every hunk line by line, then read its enclosing function.
   - For every deleted or replaced line, name the invariant it maintained and find where the new code
     re-establishes it.
   - For every changed signature or observable contract, grep its symbol and inspect callers for broken
     preconditions, return shapes, exceptions, or ordering assumptions.
```

current:

```markdown
## Bar
- Read the actual code path before asserting. Every finding carries evidence you can point at.
- Material findings only: no naming, style, or "consider extracting". One strong finding beats five weak ones.
- Anchor `line_start`/`line_end` to lines in the diff's new side.
- `verdict: approve` only if nothing blocking remains. An empty `findings` array is a valid answer.
- Under 15 findings. Under 300 words of `summary`.
```

new:

```markdown
## Bar
- Read the actual code path before asserting. Every finding must pass all eight tests:
  1. It materially affects one of the review axes above.
  2. It is one discrete, actionable defect at a concrete location.
  3. Fixing it does not demand more rigour than this codebase otherwise uses.
  4. This diff caused it. Pre-existing defects are out of scope; unchanged callers remain valid
     evidence when the changed contract breaks them.
  5. The author would likely fix it if they knew.
  6. It does not depend on unstated assumptions about the codebase or the author's intent.
  7. If it affects other code, you identified and cited that code.
  8. It is clearly not merely the intended behavior change.
- Skip deterministic failures that configured CI catches, including missing imports, type errors, lint,
  formatting, and already-failing tests. Skip naming, style, and extraction suggestions.
- `evidence` must name the triggering input, state, timing, or configuration and the resulting wrong
  output, crash, or violated invariant. Do not restate the claim.
- Calibrate `confidence`:
  - `[0.9, 1.0]`: certain; you traced the trigger through to the wrong result.
  - `[0.7, 0.9)`: likely; the mechanism is established and the trigger is realistic but unverified.
  - `[0.5, 0.7)`: plausible; part of the mechanism or trigger remains unverified. State what would
    confirm it.
  - `< 0.5`: speculative; the mechanism or trigger is not established.
- Keep `claim` to one sentence. Keep `evidence` and `recommendation` to one short paragraph each. Quote
  no more than three lines of code. Use matter-of-fact language with no preamble, flattery, or severity
  inflation. State immediately when severity depends on particular inputs or environments.
- Anchor `line_start`/`line_end` to the diff's new side. Prefer one to three lines and never exceed ten.
  If the defect is outside the diff, anchor the changed cause or nearest changed line and say so in
  `evidence`.
- Do not stop after the first qualifying finding, and do not pad. An empty `findings` array is valid.
- `verdict: approve` only if nothing blocking remains.
- Under 15 findings. Under 300 words of `summary`.
```

### R5

[review-debate.md](/Users/nagdy/LocalSites/skills/review-skills/skills/debate-review/prompts/review-debate.md:17)

current:

```markdown
- Then attack the change where the main reviewer didn't look. Prioritise expensive, hard-to-detect
  failures: auth/trust boundaries, data loss or duplication, idempotency and partial failure, races and
  ordering, null/empty/timeout paths, schema drift and migrations, observability gaps.
```

new:

```markdown
- After the verdicts, run one gap sweep for missed blocking defects, especially at auth/trust
  boundaries, data-loss or duplication paths, idempotency and partial failure, races and ordering, and
  schema or migration boundaries. Add a `D*` only when this diff caused it, it does not duplicate an
  `F*`, and its evidence cites the code, names the concrete trigger, and names the wrong result.
  Non-blocking new findings are out of scope. Zero new findings is expected on most PRs.
```

## Missed

1. [Runtime validation is only a schema-id check](/Users/nagdy/LocalSites/skills/review-skills/skills/debate-review/scripts/lib/dispatch.mjs:115). The script does not validate fields, enums, IDs, head SHA, duplicate IDs, or the required one-verdict-per-`F*` rule. Prompt mistakes can therefore pass as valid JSON.

2. The final pass still says “your findings” and names the opposing reviewer. It is also the original proposer judging its own work in a sequential rebuttal, exactly where the research reports self-preference, identity bias, and increased capitulation. Present the two positions as unattributed inputs or use an independent final judge.

3. A main-rejected `D*` becomes `contested`, and [`--contested post` is the default](/Users/nagdy/LocalSites/skills/review-skills/skills/debate-review/scripts/review-pr.mjs:309). That still publishes the second model’s rejected claim. `D*` cannot act as a precision gate until rejected `D*` findings default to drop.

## Warnings

- R1’s literal “must confirm” language would turn plausible failure modes into asserted defects.
- R2’s forced pushback would manufacture contested findings, which the pipeline posts by default.
- R3 can double the main prompt’s size. Keep the procedures compact, and do not duplicate the same evidence rule across multiple sections.
- R4 would post unverified claims under the user’s account while lacking a truthful schema status for them.
- R5 may cause severity inflation. “Blocking” must retain the schema’s existing meaning, not become a way to admit a favored `D*`.

## Net recommendation

Adopt the compact R1, R2, R3, and R5 variants above; reject R4.  
The highest-value changes are evidence-bound refutation, calibrated main findings, and the blocking-only `D*` sweep.  
Before relying on the result, validate the full JSON contract and stop posting main-rejected `D*` findings by default.