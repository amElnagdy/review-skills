# What good public LLM code-review prompts actually look like

Research for the debate-review skill (`/Users/nagdy/LocalSites/skills/review-skills/skills/debate-review/`).
Date: 2026-08-21. Every prompt excerpt below is quoted from a source I fetched; where a prompt is not
public I say so rather than paraphrasing it into existence.

---

## A. Per-source findings

### A1. Anthropic — Claude Code built-in `/code-review` skill  **(the single most useful source)**

**Where:** the prompts ship inside the Claude Code binary. They are extracted verbatim, per CLI
version, in [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts)
(`system-prompts/skill-code-review-*.md`, `system-prompts/agent-prompt-code-review-part-*.md`,
ccVersion 2.1.120–2.1.235). Public, and structurally the closest thing to your pipeline.

**Shape.** Effort is a first-class dial, and each level is a *different* prompt with a different
precision/recall posture. The header line of each mode is a literal pipeline spec:

> `low effort → 1 diff pass → no verify → ≤4 findings`
> `medium effort → 3+5 angles × 6 candidates → 1-vote verify → ≤8 findings`
> `high effort → 3+5 angles × 6 candidates → 1-vote verify (recall-biased) → ≤10 findings`
> `xhigh effort → 10 inline angles → dedup (no verify) → sweep → ≤15 findings`
>
> — Claude Code `/code-review` mode prompts

**The precision/recall stance is stated explicitly, and it flips:**

> "You are reviewing for **precision** at medium effort: every finding you surface should be one a
> maintainer would act on."
>
> "You are reviewing for **recall** at maximum effort: catch every real bug. At this level, catching
> real bugs matters more than avoiding false positives — a missed bug ships. Err on the side of
> surfacing."
>
> — `agent-prompt-code-review-part-6-medium-effort-mode.md`, `-part-3-extra-high-and-maximum-effort-modes.md`

**Findings carry a `failure_scenario`, not just a claim.** This is the highest-leverage single idea
in the whole corpus:

> ```json
> { "file": "path/to/file.ext", "line": 123,
>   "summary": "one-sentence statement of the bug",
>   "failure_scenario": "concrete inputs/state → wrong output/crash" }
> ```
> — `skill-code-review-output-findings-json-array.md`

**Three-state verification, one verifier per candidate**, with the rubric spelled out:

> "**CONFIRMED** — can name the inputs/state that trigger it and the wrong output or crash. Quote the
> line. **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env, config). State what
> would confirm it. **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere. Quote
> the line that proves it."
>
> — `agent-prompt-code-review-part-4-three-state-verification-phase.md`

And crucially, **refutation is constrained** — the refuter has to be able to build the refutation out
of the code, not out of vibes:

> "**REFUTED** only when constructible from the code: factually wrong (quote the actual line);
> provably impossible (type/constant/invariant — show it); already handled in this diff (cite the
> guard); or pure style with no observable effect."
>
> "**PLAUSIBLE by default** — do not refute a candidate for being 'speculative' or 'depends on runtime
> state' when the state is realistic: concurrency races, nil/undefined on a rare-but-reachable path
> (error handler, cold cache, missing optional field), falsy-zero treated as missing, off-by-one on a
> boundary the code does not exclude, retry storms / partial failures, regex/allowlist that lost an
> anchor. These are PLAUSIBLE."
>
> — `agent-prompt-code-review-part-5-recall-biased-verification-phase.md`

**Named finder angles instead of a topic list.** Each angle is a *procedure*, not a category:

> "**Angle A — line-by-line diff scan.** Read every hunk in the diff, line by line. Then Read the
> enclosing function for each hunk — bugs in unchanged lines of a touched function are in scope (the
> PR re-exposes or fails to fix them). For every line ask: what input, state, timing, or platform
> makes this line wrong?"
>
> "**Angle B — removed-behavior auditor.** For every line the diff DELETES or replaces, name the
> invariant or behavior it enforced, then search the new code for where that invariant is
> re-established. If you can't find it, that's a candidate: a removed guard, a dropped error path, a
> narrowed validation, a deleted test that was covering a real case."
>
> "**Angle C — cross-file tracer.** For each function the diff changes, find its callers (Grep for the
> symbol) and check whether the change breaks any call site: a new precondition, a changed return
> shape, a new exception, a timing/ordering dependency."
>
> — `skill-code-review-correctness-finder-angles.md`

Plus Angle D (language-pitfall specialist: "JS falsy-zero, `==` coercion, closure-captured loop var;
Python mutable default args, late-binding closures; Go nil-map write, range-var capture…") and Angle E
(wrapper/proxy correctness), and separate **altitude** and **conventions** dimensions.

**Anti-suppression rule between angles** — directly relevant to a debate design:

> "Do NOT let one angle's conclusions suppress another's — if two angles flag the same line for
> different reasons, record both."
>
> "Pass every candidate with a nameable failure scenario through — finders that silently drop
> half-believed candidates bypass the verify step and are the dominant cause of misses."
>
> — `skill-code-review-inline-xhigh-mode.md`, `-part-7-high-effort-mode.md`

**A gap sweep as a separate final pass, explicitly forbidden from re-litigating:**

> "Run **one more finder** as a fresh reviewer who has the verified list. Re-read the diff and
> enclosing functions looking ONLY for defects not already listed. Do not re-derive or re-confirm
> anything already there — the job is gaps. … Surface **up to 8 additional candidates** … If nothing
> new, return an empty sweep — do not pad."
>
> — `skill-code-review-phase-3-sweep-for-gaps.md`

**CLAUDE.md conventions get a quote-the-rule gate:**

> "Only flag a violation when you can quote the exact rule and the exact line that breaks it — no
> style preferences, no vague 'spirit of the doc' inferences. … If no CLAUDE.md applies, return
> nothing for this angle."
>
> — `skill-code-review-conventions-dimension.md`

**`short_summary`** is a distinct field: "the claim compressed to ≤60 characters, no rationale or
consequence clause" (`-part-10-reportfindings-output-format.md`). Useful for the inline-comment
headline.

**On "nuclear":** `/code-review` takes `low | medium | high | max | ultra`. `ultra` is a *cloud*
multi-agent review (`/ultrareview` is a deprecated alias) — "It is user-triggered and billed; you
cannot launch it yourself" (`system-prompt-explain-code-review-ultra.md`). See §D.

---

### A2. Anthropic — `/security-review` slash command

**Where:** [`agent-prompt-security-review-slash-command.md`](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/agent-prompt-security-review-slash-command.md)
(ccVersion 2.1.120). Also shipped as the open-source
[anthropics/claude-code-security-review](https://github.com/anthropics/claude-code-security-review) action.
Fully public. **The best false-positive-control prompt in existence right now**, mostly because it is
concrete rather than exhortative.

Core stance:

> "MINIMIZE FALSE POSITIVES: Only flag issues where you're >80% confident of actual exploitability …
> This is not a general code review - focus ONLY on security implications newly added by this PR. Do
> not comment on existing security concerns."

The thing worth stealing is that it does not say "avoid false positives" — it ships a **hard exclusion
list and a precedent list**, i.e. adjudicated case law:

> "HARD EXCLUSIONS - Automatically exclude findings matching these patterns: 1. Denial of Service
> (DOS) vulnerabilities … 7. A lack of hardening measures. Code is not expected to implement all
> security best practices, only flag concrete vulnerabilities. 8. Race conditions or timing attacks
> that are theoretical rather than practical issues. Only report a race condition if it is concretely
> problematic. … 11. Files that are only unit tests…"
>
> "PRECEDENTS - … 2. UUIDs can be assumed to be unguessable and do not need to be validated. 3.
> Environment variables and CLI flags are trusted values … 6. React and Angular are generally secure
> against XSS … Do not report XSS vulnerabilities in React or Angular components or tsx files unless
> they are using unsafe methods. 8. A lack of permission checking or authentication in client-side
> JS/TS code is not a vulnerability."

Each finding must carry an **exploit scenario**, not just a category — same idea as `failure_scenario`:

> "the file, line number, severity, category (e.g. `sql_injection` or `xss`), description, exploit
> scenario, and fix recommendation"

And the architecture is two-stage with a numeric gate — a *separate* agent does FP filtering, and the
threshold is applied by the orchestrator, not by the finder:

> "1. Use a sub-task to identify vulnerabilities… 2. Then for each vulnerability identified by the
> above sub-task, create a new sub-task to filter out false-positives. Launch these sub-tasks as
> parallel sub-tasks… 3. Filter out any vulnerabilities where the sub-task reported a confidence less
> than 8."

Note also: **the filter agent is denied tools that would let it wander.**

> "You do not need to run commands to reproduce the vulnerability, just read the code to determine if
> it is a real vulnerability. Do not use the bash tool or write to any files."

---

### A3. Anthropic — official `code-review` plugin (`/code-review` for a PR)

**Where:** [anthropics/claude-code → `plugins/code-review/commands/code-review.md`](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md);
also on disk at `/Users/nagdy/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-review/commands/code-review.md`.
Fully public.

Five *differently-sourced* reviewers, then a per-finding confidence jury, then an 80 cutoff:

> "launch 5 parallel Sonnet agents to independently code review the change … a. Agent #1: Audit the
> changes to make sure they compily with the CLAUDE.md. b. … do a shallow scan for obvious bugs. Avoid
> reading extra context beyond the changes … Focus on large bugs, and avoid small issues and nitpicks.
> Ignore likely false positives. c. Agent #3: Read the git blame and history of the code modified, to
> identify any bugs in light of that historical context. d. Agent #4: Read previous pull requests that
> touched these files, and check for any comments on those pull requests that may also apply. e. Agent
> #5: Read code comments in the modified files, and make sure the changes … comply with any guidance
> in the comments."

The confidence rubric is given to the scoring agent **verbatim** — and the prompt says so:

> "The scale is (give this rubric to the agent verbatim): a. 0: Not confident at all. This is a false
> positive that doesn't stand up to light scrutiny, or is a pre-existing issue. … c. 50: Moderately
> confident. The agent was able to verify this is a real issue, but it might be a nitpick or not
> happen very often in practice. Relative to the rest of the PR, it's not very important. … e. 100:
> Absolutely certain. The agent double checked the issue, and confirmed that it is definitely a real
> issue, that will happen frequently in practice. The evidence directly confirms this."
>
> "Filter out any issues with a score less than 80. If there are no issues that meet this criteria, do
> not proceed."

And the FP list is worded as *examples*, which is what makes it usable:

> "Examples of false positives … Pre-existing issues · Something that looks like a bug but is not
> actually a bug · Pedantic nitpicks that a senior engineer wouldn't call out · Issues that a linter,
> typechecker, or compiler would catch (eg. missing or incorrect imports, type errors, broken tests,
> formatting issues …). No need to run these build steps yourself -- it is safe to assume that they
> will be run separately as part of CI. · General code quality issues (eg. lack of test coverage,
> general security issues, poor documentation), unless explicitly required in CLAUDE.md · Issues that
> are called out in CLAUDE.md, but explicitly silenced in the code (eg. due to a lint ignore comment)
> · Changes in functionality that are likely intentional or are directly related to the broader change
> · **Real issues, but on lines that the user did not modify in their pull request**"

Two operational details worth copying: an **eligibility gate before and after** the expensive work
("repeat the eligibility check from #1, to make sure that the pull request is still eligible"), and a
hard rule that every finding must be cited with a permalink at a full SHA plus one line of context
either side.

---

### A4. Anthropic — `pr-review-toolkit` plugin agents

**Where:** `/Users/nagdy/.claude/plugins/marketplaces/claude-plugins-official/plugins/pr-review-toolkit/agents/`
(public in the official marketplace). Six specialist agents: `code-reviewer`, `silent-failure-hunter`,
`pr-test-analyzer`, `comment-analyzer`, `type-design-analyzer`, `code-simplifier`.

`code-reviewer` restates the confidence gate compactly:

> "Rate each issue from 0-100: **0-25**: Likely false positive or pre-existing issue · **26-50**: Minor
> nitpick not explicitly in CLAUDE.md · **51-75**: Valid but low-impact issue · **76-90**: Important
> issue requiring attention · **91-100**: Critical bug or explicit CLAUDE.md violation.
> **Only report issues with confidence ≥ 80** … Be thorough but filter aggressively - quality over
> quantity."

`silent-failure-hunter` is the best example of a **narrow specialist prompt that asks a question set
rather than naming a category**, and it demands the reviewer enumerate what a catch block *hides*:

> "**Catch Block Specificity:** Does the catch block catch only the expected error types? Could this
> catch block accidentally suppress unrelated errors? **List every type of unexpected error that could
> be hidden by this catch block.** Should this be multiple catch blocks for different error types?"
>
> "**Fallback Behavior:** … Is this fallback explicitly requested by the user or documented in the
> feature spec? Does the fallback behavior mask the underlying problem? … Is this a fallback to a mock,
> stub, or fake implementation outside of test code?"

Its output format requires a **Hidden Errors** field — "List specific types of unexpected errors that
could be caught and hidden" — which is a nice generalisation of `evidence`.

`pr-test-analyzer` scores by *criticality of the regression prevented*, not by coverage:

> "**Rating Guidelines:** 9-10: Critical functionality that could cause data loss, security issues, or
> system failures · 7-8: Important business logic that could cause user-facing errors · 5-6: Edge
> cases … 1-2: Minor improvements that are optional"
>
> "For each suggested test or modification: Provide specific examples of failures it would catch …
> Explain the specific regression or bug it prevents … **Consider whether existing tests might already
> cover the scenario**"
>
> "Focus on tests that prevent real bugs, not academic completeness … Avoid suggesting tests for
> trivial getters/setters unless they contain logic."

---

### A5. Community — `alecnielsen/adversarial-review` (Claude + Codex debate loop)

**Where:** [github.com/alecnielsen/adversarial-review](https://github.com/alecnielsen/adversarial-review),
prompts in `prompts/`. Fully public. This is the closest public analogue to your architecture: four
phases — `initial_review` → `cross_review` → `meta_review` → `synthesis`.

What it does that you don't: it makes the **cross-reviewer's verdict vocabulary explicit and
symmetric**, and it forces a *count* out of the debate so drift is measurable.

> "### If you AGREE: State 'VALID' and explain why … ### If you DISAGREE: State 'INVALID' or 'FALSE
> POSITIVE' and explain why. Provide evidence (code context, documentation, etc.) ### If you have
> CONCERNS: State 'UNCLEAR' or 'NEEDS MORE CONTEXT'"
>
> "**Adversarial Perspective** — Be critical but fair: Don't accept findings at face value - verify
> them. **Don't reject findings just to disagree - have reasons.** Consider if the other agent has
> context you're missing. Consider if you have context they're missing."
>
> — `prompts/cross_review.md`

The meta/rebuttal phase names the three moves plainly and — importantly — treats *conceding* as a
first-class labelled act rather than a silent drop:

> "### If their challenge is VALID: State 'CONCEDE' … Withdraw or downgrade the finding.
> ### If their challenge is INVALID: State 'MAINTAIN'. Provide additional evidence/reasoning …
> ### If more information needed: State 'CLARIFY'"
>
> "For New Issues They Found … 'VALID-NEW': They found something real I missed · 'INVALID-NEW': Their
> new finding is incorrect · **'DUPLICATE': Already covered in my original review**"
>
> — `prompts/meta_review.md`

And the arbiter tiers action by **agreement structure**, which is the useful bit for severity policy:

> "### High Confidence Fixes (Implement Immediately) — Issues where BOTH agents agreed: Both found the
> same issue independently · One found it, the other validated it · Neither raised objections in
> meta-review … ### Low Confidence / Skip — Issues where agents DISAGREED"
>
> "**Don't over-fix**: If agents disagreed, err on the side of not changing working code"
>
> — `prompts/synthesis.md`

It also emits a machine-readable status block per phase (`FINDINGS_VALIDATED / FINDINGS_CHALLENGED /
FINDINGS_ADDED / AGREEMENT_LEVEL`) — you get this for free from your JSON, but the
`AGREEMENT_LEVEL: FULL|PARTIAL|LOW` summary is a cheap health signal you currently don't surface.

---

### A6. Community — `richiethomas/claude-devils-advocate`

**Where:** [github.com/richiethomas/claude-devils-advocate](https://github.com/richiethomas/claude-devils-advocate),
`devils-advocate.md`. Public. Simulates Author vs Reviewer over N rounds. One rule in it is the single
most valuable line for your rebuttal prompt, because it directly targets sycophancy:

> "The Reviewer MUST raise at least one substantive concern per round. Do not nitpick style when real
> issues remain. **The Author MUST push back on at least one point per round rather than immediately
> conceding everything.** Defend the decision or explain the tradeoff before agreeing to change
> anything."
>
> "Move on when a topic is genuinely resolved. **Do not pad rounds with manufactured concerns** to stay
> on a topic longer."

It also has an explicit *topic priority order* (correctness → error handling → performance → security
→ maintainability → testing gaps) and a "Deferred concerns" section so nothing is silently dropped.

---

### A7. Community — `wan-huiyan/agent-review-panel`

**Where:** [github.com/wan-huiyan/agent-review-panel](https://github.com/wan-huiyan/agent-review-panel).
Public. A many-reviewer debate panel with a judge. Two of its docs are more useful than its prompts:

`docs/research-foundations.md` lists the papers it builds on (ChatEval ICLR'24; Du et al.
[arXiv:2305.14325](https://arxiv.org/abs/2305.14325) ICML'24; MachineSoM ACL'24; CONSENSAGENT ACL'25
"dynamic sycophancy intervention"; Trust or Escalate [arXiv:2407.18370](https://arxiv.org/abs/2407.18370)
ICLR'25 "judge confidence gating with selective escalation"). *Attribution note: this table is that
repo's own claim; I verified the two arXiv IDs resolve, not each venue.*

`docs/analysis/2026-06-06-debate-disappearance-audit.md` is a self-audit of 51 real runs and contains
the sharpest statement of when debate is worth its cost:

> "fan-out (no debate) is right when the sub-tasks are independent; debate is worth its cost only when
> reviewers would genuinely change each other's verdicts (security vs perf, correctness vs
> readability, is-this-P0-real). High-stakes gating reviews are squarely in the debate-worthy column"

And a failure mode you should defend against structurally: **the debate phase silently not happening**.

> "Debate-skip must be loud, not silent. When the panel runs but Phase 5 produced no
> `reviewer_*_phase_5_round1.md` state files, the report should carry a `[NO-DEBATE]` /
> `[COMPRESSED]` banner"

---

### A8. Google `eng-practices` (the human baseline that most review prompts crib from)

**Where:** [google.github.io/eng-practices/review/reviewer/standard.html](https://google.github.io/eng-practices/review/reviewer/standard.html)
and [`looking-for.html`](https://google.github.io/eng-practices/review/reviewer/looking-for.html). Not a
prompt — a human guide — but it supplies the two lines that keep review prompts calibrated:

> "In general, reviewers should favor approving a CL once it is in a state where it definitely improves
> the overall code health of the system being worked on, even if the CL isn't perfect."
>
> "Technical facts and data overrule opinions and personal preferences."

Plus the `Nit:` convention for explicitly non-binding comments — which is exactly what your
`non-blocking` severity is, and which you could make visible in the posted comment.

---

### A9. OpenAI — `codex review` (the CLI's native reviewer)

**Where:** [`codex-rs/prompts/templates/review/rubric.md`](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/review/rubric.md)
in openai/codex, Apache-2.0. **Fully public.** (It used to live at `codex-rs/core/review_prompt.md`;
that path 404s on `main` now.) Loaded as `REVIEW_PROMPT` in `codex-rs/prompts/src/review_request.rs`.

This is the best-written *bar* in the corpus. Instead of "only material findings", it gives eight
tests, and test #5 is the one that actually calibrates a model:

> "1. It meaningfully impacts the accuracy, performance, security, or maintainability of the code.
> 2. The bug is discrete and actionable (i.e. not a general issue with the codebase or a combination
> of multiple issues). 3. Fixing the bug does not demand a level of rigor that is not present in the
> rest of the codebase … 4. The bug was introduced in the commit (pre-existing bugs should not be
> flagged). **5. The author of the original PR would likely fix the issue if they were made aware of
> it.** 6. The bug does not rely on unstated assumptions about the codebase or author's intent.
> **7. It is not enough to speculate that a change may disrupt another part of the codebase, to be
> considered a bug, one must identify the other parts of the code that are provably affected.**
> 8. The bug is clearly not just an intentional change by the original author."

The stopping rule is stated as a *both-ways* instruction — no padding, no early exit:

> "Output all findings that the original author would fix if they knew about it. If there is no
> finding that a person would definitely love to see and fix, prefer outputting no findings.
> **Do not stop at the first qualifying finding. Continue until you've listed every qualifying
> finding.**"

There is a whole section on **comment craft**, which nobody else has and which matters a lot when the
output lands as an inline PR comment:

> "2. The comment should appropriately communicate the severity of the issue. It should not claim that
> an issue is more severe than it actually is. 3. The comment should be brief. The body should be at
> most 1 paragraph … 4. The comment should not include any chunks of code longer than 3 lines.
> **5. The comment should clearly and explicitly communicate the scenarios, environments, or inputs
> that are necessary for the bug to arise. The comment should immediately indicate that the issue's
> severity depends on these factors.** 6. The comment's tone should be matter-of-fact and not
> accusatory or overly positive … 8. The comment should avoid excessive flattery … phrasing like
> 'Great job ...', 'Thanks for ...'."

Line-anchoring guidance you don't have and should:

> "Always keep the line range as short as possible for interpreting the issue. Avoid ranges longer
> than 5–10 lines; instead, choose the most suitable subrange that pinpoints the problem."
> "The code_location should overlap with the diff."

Severity is a **P0–P3 tag prefixed into the title**, with P0 defined so it can't be inflated:

> "[P0] – Drop everything to fix. Blocking release, operations, or major usage. **Only use for
> universal issues that do not depend on any assumptions about the inputs.**"

And there's a separate global verdict field distinct from the findings list:

> "output an 'overall correctness' verdict of whether or not the patch should be considered 'correct'.
> Correct implies that existing code and tests will not break, and the patch is free of bugs and other
> blocking issues. Ignore non-blocking issues such as style, formatting, typos, documentation…"

A newer **Repository Rule Attribution** section governs AGENTS.md usage and is worth reading against
your `standards` axis — note the "materially contributes beyond generic correctness advice" gate and
the explicit anti-overcorrection clause:

> "A finding is rule-supported only when applicable guidance materially contributes repository-specific
> scope, an invariant, remedy, convention, or confirmation behavior beyond generic correctness advice.
> … **Do not omit ordinary findings or invent findings solely because a rule file exists.**"
> "For each rule-supported final finding, verify the applicable project instruction file that supplies
> the rule and its smallest supporting line range … **Do not fabricate citations**"

**Codex on GitHub** ([learn.chatgpt.com/docs/third-party/github](https://learn.chatgpt.com/docs/third-party/github)):
the wrapper prompt is *not* public, but the docs state the filter — "In GitHub, Codex flags only P0 and
P1 issues so review comments stay focused on high-priority risks" — and tell you to put a
`## Code Review Rules` section in AGENTS.md, keeping "formatting, lint, and other deterministic checks"
out of it.

---

### A10. OpenAI — `codex-plugin-cc` adversarial-review prompt  ⚠️ **this is your review-debate.md's ancestor**

**Where:** [openai/codex-plugin-cc → `plugins/codex/prompts/adversarial-review.md`](https://github.com/openai/codex-plugin-cc/blob/main/plugins/codex/prompts/adversarial-review.md).
Public, official OpenAI repo.

Read this side by side with your `review-debate.md` — the lineage is unmistakable ("break confidence
in the change, not to validate it"; "Default to skepticism"; the auth/data-loss/idempotency/races/
schema-drift/observability attack list; "Prefer one strong finding over several weak ones"). So the
question is not what to copy but **what you dropped in adapting it**. Three things:

> `<finding_bar>` "A finding should answer: 1. What can go wrong? 2. Why is this code path vulnerable?
> 3. What is the likely impact? 4. What concrete change would reduce the risk?"

> `<review_method>` "**Actively try to disprove the change.** Look for violated invariants, missing
> guards, unhandled failure paths, and assumptions that stop being true under stress. **Trace how bad
> inputs, retries, concurrent actions, or partially completed operations move through the code.**"

> `<final_check>` "Before finalizing, check that each finding is: adversarial rather than stylistic ·
> tied to a concrete code location · plausible under a real failure scenario · actionable for an
> engineer fixing the issue"

The `<final_check>` self-audit block is the cheapest high-value addition available to you. Also note
its grounding clause is sharper than yours:

> "Do not invent files, lines, code paths, incidents, attack chains, or runtime behavior you cannot
> support. **If a conclusion depends on an inference, state that explicitly in the finding body and
> keep the confidence honest.**"

Same repo, `plugins/codex/prompts/stop-review-gate.md`, has a rule directly applicable to your
rebuttal pass — don't trust the other model's account of reality:

> "**Do not treat the previous Claude response as proof that code changes happened; verify that from
> the repository state before you block.**"

**Bonus:** OpenAI dogfoods a fan-out review in [`openai/codex/.codex/skills/`](https://github.com/openai/codex/tree/main/.codex/skills)
— an orchestrator plus `code-review-context`, `-change-size`, `-testing`, `-breaking-changes`. The
orchestrator: *"One subagent per skill… Use xhigh reasoning. You must return every single issue from
every subagent."* The children encode hard numeric house rules (≤800 changed lines, ≤500 for complex
logic) rather than adjectives.

---

### A11. Cursor — Bugbot, Agent Review, and "thermo-nuclear review"

**Bugbot's prompt: not public.** Verified absent from all three major leaked-prompt collections
(`elder-plinius/CL4R1T4S`, `x1xhlol/system-prompts-and-models-of-ai-tools`,
`lucasmrdt/TheBigPromptLibrary` carry only Cursor's *IDE agent* prompts). Docs describe the config
surface: [cursor.com/docs/bugbot](https://cursor.com/docs/bugbot).

> "Create `.cursor/BUGBOT.md` files to provide project-specific context for reviews. Bugbot always
> includes the root `.cursor/BUGBOT.md` file and any additional files found while traversing upward
> from changed files."
> "Order of inclusion: Team Rules → project .cursor/BUGBOT.md (including nested files) → learned rules
> → manual rules."

Rules carry **scoped path globs**, learned rules accrue from `@cursor remember [fact]`, and
`bugbot run verbose=true` prints which rules were actually used. Effort is a dial: *Default / High /
Custom* — "**Custom**: Lets you describe when Bugbot should use longer and deeper reviews."

Their engineering blog ([Building a better Bugbot](https://cursor.com/blog/building-bugbot)) describes
the *old* pipeline — eight parallel passes over randomized diff orderings, majority voting, a category
filter, then a separate validator model — and reports a stance reversal that matters for your debate
design:

> "With earlier versions of Bugbot we needed to restrain the models to minimize false positives. But
> with the agentic approach we encountered the opposite problem: it was too cautious. We shifted to
> aggressive prompts that encouraged the agent to investigate every suspicious pattern and err on the
> side of flagging potential issues." — Jon Kaplan, Cursor

**On "nuclear review": it's real, it's called *thermo-nuclear*, and the prompt is public.** It is not
a depth setting in the Cursor app — it's a pair of skills in the MIT-licensed
[cursor/plugins](https://github.com/cursor/plugins) repo, invoked manually
(`disable-model-invocation: true`) and orchestrated in parallel by the `thermos` plugin.

**`thermo-nuclear-review`** ([SKILL.md](https://github.com/cursor/plugins/blob/main/thermos/skills/thermo-nuclear-review/SKILL.md)) — security + correctness:

> "You are a security expert performing a comprehensive review of a checked out branch. Audit this
> branch and its changes extremely thoroughly for bugs, changes that break existing
> features/functionality, and security vulnerabilities. Be EXTREMELY thorough, rigorous, careful,
> ambitious, and attentive. NOTHING can slip through."

> "ONLY report issues related to code that is being ADDED or MODIFIED in this PR. Focus on changes in
> the diff. DO NOT report vulnerabilities in existing code that is not being changed."

The anti-inflation clause is the best-phrased one anywhere, because it names the *consequence*:

> "**If you report issues as High priority when they are not in fact high priority / meaningful issues,
> devs will lose trust in you and stop listening to you over time. NEVER misreport the priority /
> importance of issues.**"

It also reads existing BugBot comments on the PR **only after** finishing its own audit — "This way
you have fresh eyes while you review" — which is exactly the independence property your main/debate
split is trying to buy.

**`thermo-nuclear-code-quality-review`** ([SKILL.md](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md)) — maintainability. Reportedly Cursor's most-used internal skill.

> "Assume there is often a 'code judo' move available: a re-organization that uses the existing
> architecture more effectively and makes the change dramatically simpler and more elegant. If you see
> a path to delete complexity rather than rearrange it, push hard for that path."
> "**Do not let a PR push a file from under 1k lines to over 1k lines without a very strong reason.**"
> "Do not flood the review with low-value nits if there are larger structural issues. Prefer a smaller
> number of high-conviction comments over a long list of cosmetic notes."

**Cursor Agent Review** ([docs](https://cursor.com/docs/agent/agent-review)) has two depth levels,
**Quick** and **Deep** — no "nuclear", "max", or "ultra" setting exists in the product.

**Bonus, and unusually useful:** [`pstack/skills/poteto-mode/references/bugbot-triage.md`](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/references/bugbot-triage.md)
is a public `fix` / `dismiss` / `ask` rubric for triaging *bot output*, with named false-positive
patterns each tagged `Confidence: candidate | recurring | strong`, plus "Skip when" / "Do not skip
when" boundaries and an "Ask by default" list (security, privacy, auth, billing, migrations,
concurrency). That's a ready-made model for a `contested`-handling policy.

---

### A12. Greptile

**Prompt: not public; docs describe the config surface.** The interesting part is that *nitpick control
is a numeric dial plus a category allowlist*, not prose.

[Controlling nitpickiness](https://www.greptile.com/docs/code-review/controlling-nitpickiness):

> "`strictness` … `1` = verbose (all issues), `2` = balanced (default), `3` = critical only"
> "`logic` - Business logic issues, algorithmic problems, potential bugs; `syntax` - Language-specific
> best practices, proper usage patterns; `style` - Code formatting, naming conventions, structural
> consistency"

[Config reference](https://www.greptile.com/docs/code-review/greptile-config-reference): `.greptile/config.json`
carries `rules[]` with `rule`, `id`, `scope` (globs), **`severity: low|medium|high` per rule**,
`enabled`, plus `disabledRules` for monorepo cascading. `.greptile/rules.md` is free-form: "Plain
markdown passed to the reviewer as context… There is no special syntax or parsing."

[Nitpicks / memory](https://www.greptile.com/docs/how-greptile-works/nitpicks): the feedback loop is
mechanical — "Greptile reads the **first** and **last** commit of every PR to see which comments were
addressed" — and comment *classes* that get ignored are down-weighted over time, while security and
logic comments are never suppressed. Claimed effect: "80% reduction in ignored comments, 3x higher
suggestion adoption rate" (vendor claim, no methodology published).

---

### A13. Graphite (Diamond → "Graphite Agent" / AI Reviews)

**Prompt: not public.** But [AI review customization](https://graphite.com/docs/ai-review-customization)
is effectively a public *prompt-writing style guide*, and it's the best short one I found.

> "Make the language as targeted as possible… If an exclusion is written too broadly, then Graphite
> Agent may not leave valid comments."
> Bad: "Don't suggest performance improvements." → Good: "Do not suggest performance optimizations for
> code in the /scripts directory - these are one-time utility scripts."

Their "What to avoid" list is a direct rebuke of how most review prompts are written:

> "Unnecessary context ('you are a staff-level engineer'); Overly broad rules ('write good code');
> Praise; **Non-prescriptive verbs ('comment on' or 'flag')**; Comments that should actually be
> exclusions ('don't comment on')"

Prescribed rule format: **Rule → Bad example → Good example → Reasoning**, one concern per rule.
They also ship per-rule and per-exclusion analytics (issues found, acceptance rate, % caught), which is
the closest thing to an eval loop any vendor exposes. Marketing claims "sub-3% false positive rate";
methodology is described on Braintrust's customer page, not by Graphite.

---

### A14. CodeRabbit

**Prompt: not public.** The config surface is, and it is the largest of any vendor. Authoritative
source is the public JSON schema:
[`schema.v2.json`](https://storage.googleapis.com/coderabbit_public_assets/schema.v2.json).

**Correction to a common assumption:** there is **no `reviews.instructions` field** — CodeRabbit has no
global free-text review-instruction knob. Instructions are split across `tone_instructions` (top-level,
250 chars), `reviews.path_instructions[].instructions` (glob-scoped, **20,000 chars each**),
`high_level_summary_instructions` (250), `labeling_instructions` (3,000),
`pre_merge_checks.custom_checks[].instructions` (10,000), and `post_merge_actions[].prompt` (10,000).

Verbosity is a three-way profile, not prose:

> `reviews.profile` — "Set the review profile: quiet for only the most important feedback, chill for
> balanced feedback, assertive for more feedback (which may feel nitpicky)." (default `chill`)

Nicely, the profile **propagates into the linters**: `reviews.tools.phpstan.level` — "`chill` uses
level 3 (real bugs only …) and `assertive` uses level 8".

The [review-instructions guide](https://docs.coderabbit.ai/guides/review-instructions) has the single
best piece of advice on *when* to add custom instructions at all:

> "CodeRabbit's built-in review logic covers a wide range of issues by default. **Path instructions
> work best as a targeted supplement, not a replacement.** Observe a few reviews first. If something
> is consistently missed or needs to be applied differently for a specific part of the codebase,
> that's a good candidate for a path instruction."

Their published example block shows the house style — imperative bullets naming a *concrete artifact
class*, never a quality adjective:

> ```yaml
> - path: "src/controllers/**"
>   instructions: |
>     - Focus on authentication, authorization, and input validation.
>     - Flag any direct database queries that bypass the ORM layer.
> - path: "docs/**.md"
>   instructions: |
>     Check for clarity, accuracy, and completeness.
>     Flag any references to deprecated APIs or outdated behavior.
> ```

[Custom checks](https://docs.coderabbit.ai/pr-reviews/custom-checks) is the most transferable
prompt-writing doc they publish. Four rules — "Be specific and actionable" (avoid "Check for security
issues"), "Define clear pass/fail criteria", "**One concern per check**", "Include examples for complex
rules" — plus an explicit anti-pattern table:

| Problem | Their example | Why it fails |
|---|---|---|
| Vague language | "Verify best practices" | Lacks concrete pass/fail measures |
| Inaccessible data | "Ensure PR is approved by @security-team" | Agent cannot assess approval status |
| Subjective judgment | "Assess if optimizations seem obvious" | No definitive pass/fail standard |

Their framing of the whole exercise is worth repeating: treat instructions as guidance for
"a smart teammate who needs explicit criteria, not subjective judgment."

**How the review runs** ([engineering blog](https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases)) —
the key mechanism is *execution*, not more reasoning:

> "When something needs checking, CodeRabbit generates shell/Python checks (think grep, ast-grep) to
> confirm an assumption or extract proof from the codebase before we post the comment."
> "Comments come with receipts."

Plus `ast-grep` rules as a deterministic escape hatch, **Learnings** accrued from PR chat replies
(scoped `auto|global|local`, with an admin `approval_delay`), auto-detected **Code Guidelines** from
`**/AGENTS.md`, `**/CLAUDE.md`, `**/.cursorrules` and friends, 40–50 wired-in linters whose output is
re-validated by the reasoning layer rather than posted raw, and a per-comment **source attribution**
line naming which of seven inputs produced it.

---

### A15. Anthropic — the managed Code Review product, and how Anthropic reviews internally

**[code.claude.com/docs/en/code-review](https://code.claude.com/docs/en/code-review)** — described, not
quoted as a prompt, but the architecture statement matches everything above:

> "multiple agents analyze the diff and surrounding code in parallel on Anthropic infrastructure. Each
> agent looks for a different class of issue, then a verification step checks candidates against actual
> code behavior to filter out false positives. The results are deduplicated, ranked by severity, and
> posted as inline comments"

Severity is 🔴 Important / 🟡 Nit / 🟣 **Pre-existing** — a third bucket for "real, but not yours",
which is a neat alternative to silently dropping such findings. Customisation is a repo-root
`REVIEW.md` "given to the agents that find and verify findings and consulted by the agents that rank
and report them", with documented tunable axes including a **Verification bar** ("behavior claims need
a `file:line` citation in the source, not an inference from naming") and **Re-review convergence**
("after the first review, suppress new nits and post Important findings only"). CLAUDE.md violations
are downgraded to nits by default.

**[claude-code-action](https://github.com/anthropics/claude-code-action)** dogfoods a fan-out with a
one-line filter that is worth stealing verbatim:

> "Perform a comprehensive code review using subagents for key areas: code-quality-reviewer /
> performance-reviewer / test-coverage-reviewer / documentation-accuracy-reviewer /
> security-code-reviewer. **Instruct each to only provide noteworthy feedback. Once they finish,
> review the feedback and post only the feedback that you also deem noteworthy.**"
>
> — `.claude/commands/review-pr.md`

(Note: `direct_prompt` is deprecated; it was renamed `prompt` in v1.)

The newer in-repo `plugins/code-review` variant in `anthropics/claude-code` tightens the precision
block further:

> "**CRITICAL: We only want HIGH SIGNAL issues.** … Do NOT flag: Code style or quality concerns ·
> Potential issues that depend on specific inputs or state · Subjective suggestions or improvements.
> **If you are not certain an issue is real, do not flag it. False positives erode trust and waste
> reviewer time.**"
> "Never post a committable suggestion UNLESS committing the suggestion fixes the issue entirely."

**[How Anthropic secures its AI-native SDLC](https://claude.com/blog/how-anthropic-secures-its-ai-native-software-development-lifecycle)**
— the one line most relevant to your `evidence` field:

> "Each review agent is designed and scoped to a specific, narrow focus… [we] gained confidence in the
> findings by **requiring the agents to write a proof that their finding is valid**."

They report the share of PRs receiving substantive review comments going from 16% to 54%.

---

### A16. The research literature — and where it disagrees with your architecture

This section matters more than the prompt archaeology, because two well-measured results cut against
a symmetric two-model debate. *Papers below were verified to exist by ID/title/authors; figures are as
reported in each paper's own abstract or tables.*

**Baseline precision for LLM code review is far worse than vendor marketing implies.**
CR-Bench ([arXiv:2603.11078](https://arxiv.org/abs/2603.11078), Nutanix) measures a
signal-to-noise ratio by labelling each comment Bug Hit / Valid Suggestion / Noise: single-shot GPT-5.2
scored **27.0% recall at 3.6% precision, SNR 5.11**. SWR-Bench
([arXiv:2509.01494](https://arxiv.org/html/2509.01494v2), 1,000 manually verified PRs) puts precision
across *all* evaluated tools at **2.79%–16.65%**. Vendors quote 3–8% "false positive rates" because
they measure FP as a share of *posted* comments after filtering; benchmarks measure against
ground-truth defect sets. Both numbers are honest; don't mix them.

**A self-reflection loop bought recall and destroyed signal.** CR-Bench again: adding Reflexion moved
recall 27.0 → 32.8% but **SNR 5.11 → 1.95**, and below 1.0 on a small model — more noise than signal.
The theory backing: Huang et al., *LLMs Cannot Self-Correct Reasoning Yet*
([arXiv:2310.01798](https://arxiv.org/abs/2310.01798), ICLR 2024) — "LLMs struggle to self-correct
their responses without external feedback, and at times, their performance even degrades after
self-correction."

**⚠️ Unioning two reviewers' findings measurably hurts.** *Bigger Isn't Always Better*
([arXiv:2606.15689](https://arxiv.org/html/2606.15689v1)) tested union ensembles across five models:

| Union ensemble | F1 |
|---|---|
| Haiku alone | **0.365** |
| Haiku ∪ Sonnet | 0.333 |
| Haiku ∪ GPT-5.4-mini | 0.331 |
| Haiku ∪ GLM | 0.304 |

> "**Ensembles *hurt* F1.** The models largely detect the same bugs; adding a second model introduces
> its false positives without meaningfully increasing true positives."

Same paper: F1 collapses **15×** from small diffs (0.66–0.87 under 10 lines) to large ones
(0.043–0.070 at 150–600 lines), and Performance-category recall was **0.0%** for most models.

**But using the second model as a *gate* works, repeatedly and by large margins.**
- Refute-or-Promote ([arXiv:2604.19049](https://arxiv.org/abs/2604.19049)) — adversarial gates with an
  explicit "kill mandate" plus a **Cross-Model Critic from a different model family**: ~79–83% of
  candidates killed before disclosure; the cross-family critic "found correctness errors in 3/19 (~16%)
  same-family-approved proposed fixes" and surfaced 3 bugs same-family review missed; "adversarial
  review adjusted severity scores downward in 8 of 9 cases."
- QASecClaw ([arXiv:2605.01885](https://arxiv.org/html/2605.01885v1)) — LLM filter over Semgrep:
  precision 0.695 → **0.951**, **88.6% of false positives eliminated at 3.1% recall cost**. Its safety
  rule is worth copying: **fail-open** — if the filter errors, times out, or returns malformed output,
  the original finding is *retained*.
- LLM4PFA ([arXiv:2601.18844](https://arxiv.org/html/2601.18844v1), Fudan + Tencent, real industrial
  alarms) — eliminated **94–98% of false positives with recall held above 0.86**, against a 76% baseline
  FP rate and 10–20 minutes of human triage per alarm.

**Debate specifically: heterogeneity is the active ingredient; sequence is the poison.**
- Khan et al., *Debating with More Persuasive LLMs Leads to More Truthful Answers*
  ([arXiv:2402.06782](https://arxiv.org/abs/2402.06782), ICML 2024 best paper) — debate lifted
  non-expert judge accuracy from 48%→76% (LLM judge) and adversarial protocols beat non-adversarial ones.
- Zhang et al., *If Multi-Agent Debate is the Answer, What is the Question?*
  ([arXiv:2502.08788](https://arxiv.org/html/2502.08788v1)) — across 5 MAD methods × 9 benchmarks × 4
  models, "MAD methods fail to reliably outperform simple single-agent baselines such as Chain-of-Thought
  and Self-Consistency." Their **one** reliable positive: "model heterogeneity can significantly improve
  MAD frameworks."
- Kim & Khashabi, *Challenging the Evaluator: LLM Sycophancy Under User Rebuttal*
  ([arXiv:2509.16533](https://arxiv.org/abs/2509.16533)) — models "readily agree with user
  counterarguments", and are **more likely to endorse a counterargument delivered as a conversational
  follow-up than when both positions are shown side by side**. Susceptibility *increases* when the
  rebuttal includes detailed reasoning, even when its conclusion is wrong.
- Choi, Zhu & Li, *When Identity Skews Debate* ([arXiv:2510.07517](https://arxiv.org/abs/2510.07517)) —
  agents are "prone to identity-driven sycophancy and self-bias"; identity bias is widespread, with
  **sycophancy far more common than self-bias**; the mitigation is anonymising who said what.
- Shi et al., *Judging the Judges: Position Bias in LLM-as-a-Judge*
  ([arXiv:2406.07791](https://arxiv.org/abs/2406.07791), >150,000 evaluation instances) — GPT-4 position
  consistency **0.82 ± 0.15**, i.e. ~18% of paired judgments flip on order alone, and bias is "strongly
  affected by the quality gap between solutions" — worst exactly on close calls.
- Self-preference bias ([arXiv:2410.21819](https://arxiv.org/abs/2410.21819);
  [arXiv:2604.22891](https://arxiv.org/abs/2604.22891)) — models favour their own outputs; a structured
  multi-dimensional rubric cut it by 31.5% on average. Corollary: don't let the model that produced a
  finding be the model that scores it.

**Hamel Husain** on judge design ([LLM-as-a-Judge guide](https://hamel.dev/blog/posts/llm-judge/),
[Evals FAQ](https://hamel.dev/blog/posts/evals-faq/)):

> "A binary decision forces everyone to consider what truly matters. It simplifies the evaluation to a
> single, crucial question."
> "Error analysis is **the most important activity in evals**."
> "Generic evaluations waste time and create false confidence."

He names uncalibrated 1–5 scales across multiple dimensions as an explicit anti-pattern — relevant to
your `confidence` float, which needs anchors or it becomes decorative.

---

## B. The techniques that show up repeatedly

Ranked by how much evidence stands behind them and how cheap they are to adopt.

**1. Ship a "do NOT report" list, not an instruction to avoid false positives.**
Every serious prompt has one; none of them rely on the adjective "material". Anthropic
`/security-review` (17 hard exclusions + 12 precedents), official `code-review` plugin (9 worked
examples), Codex `rubric.md` (test 4: pre-existing bugs), Cursor `thermo-nuclear-review`
("ONLY report issues related to code that is being ADDED or MODIFIED"), CodeRabbit custom-checks
anti-pattern table, Graphite's exclusions doc, Claude Code low-effort mode ("Do **not** flag style,
naming, perf, missing tests, or anything outside the hunk").

**2. Exclude what CI already catches, and say why.**
Anthropic plugin: "Issues that a linter, typechecker, or compiler would catch … it is safe to assume
that they will be run separately as part of CI." Codex docs: leave "formatting, lint, and other
deterministic checks" out of review rules. Graphite, CodeRabbit likewise.

**3. Exclude pre-existing defects and unmodified lines — explicitly.**
Codex rubric test 4; Anthropic plugin ("Real issues, but on lines that the user did not modify");
Cursor thermo-nuclear; Anthropic `/security-review` ("Do not comment on existing security concerns").
Anthropic's managed product goes one better and gives them their own 🟣 Pre-existing severity.

**4. Require a concrete failure scenario, not a category label.**
Claude Code `/code-review` (`failure_scenario`: "concrete inputs/state → wrong output/crash");
`/security-review` (`exploit_scenario`); Codex rubric ("clearly and explicitly communicate the
scenarios, environments, or inputs that are necessary for the bug to arise"); OpenAI adversarial-review
(4-question finding bar); Anthropic's SDLC blog ("requiring the agents to write a proof that their
finding is valid"); CodeRabbit ("comments come with receipts").

**5. Quote the line. Cite the rule. Never infer from naming.**
Claude Code conventions dimension ("quote the exact rule and the exact line that breaks it — no …
'spirit of the doc' inferences"); Codex Repository Rule Attribution ("Do not fabricate citations");
managed Code Review's Verification bar ("a `file:line` citation in the source, not an inference from
naming"); Anthropic plugin (permalinks at full SHA with a line of context either side).

**6. Verification is a *separate pass* with a three-state vocabulary — and REFUTE has the highest bar.**
Claude Code CONFIRMED / PLAUSIBLE / REFUTED with "REFUTED only when constructible from the code" and
"PLAUSIBLE by default … do not refute for being speculative when the state is realistic";
`/security-review`'s parallel FP-filter sub-tasks; `adversarial-review`'s cross_review VALID / INVALID /
UNCLEAR; QASecClaw and LLM4PFA in the literature. **This is the most load-bearing technique in the
corpus** and the one your debate prompt currently under-specifies.

**7. Gate on a calibrated numeric threshold, and publish the rubric verbatim.**
`≥80/100` (Anthropic plugin, pr-review-toolkit `code-reviewer`), `≥8/10` (`/security-review`
orchestration), `>0.7` (security Action JSON), Greptile `strictness: 1|2|3`, CodeRabbit
`profile: quiet|chill|assertive`, Codex P0–P3 with P0 defined so it can't be inflated. Hamel Husain's
warning applies: an unanchored 1–5 (or 0–1) scale is worse than no scale.

**8. Make effort/precision-vs-recall an explicit, named stance in the prompt.**
Claude Code flips it per level ("reviewing for **precision**" vs "reviewing for **recall** … a missed
bug ships"); Cursor Bugbot Default/High/Custom and Agent Review Quick/Deep; Cursor's blog on having to
*reverse* the stance when they went agentic; Greptile strictness; CodeRabbit profile.

**9. Give procedures, not categories — especially the deleted-line audit.**
Claude Code Angles A–E; OpenAI's own `.codex/skills/code-review-*`; `silent-failure-hunter`'s question
set; CodeRabbit's "flag any direct database queries that bypass the ORM layer" style. The
removed-behavior audit (Angle B) appears nowhere else and is where regressions hide.

**10. Fan out narrowly and independently; don't let one lens suppress another.**
5 Sonnet agents (Anthropic plugin), 8–10 finder angles (Claude Code), 5 named reviewers
(claude-code-action), 6 specialists (pr-review-toolkit), 4 skills (OpenAI `.codex/skills`), 8 randomized
passes (old Bugbot). Explicit rule: "Do NOT let one angle's conclusions suppress another's."

**11. Add a gap sweep that is forbidden from re-litigating.**
Claude Code Phase 3 ("looking ONLY for defects not already listed … If nothing new, return an empty
sweep — do not pad"); `adversarial-review`'s "Expand" objective; `cross_review`'s FINDINGS_ADDED.

**12. State the stopping rule in both directions.**
Codex: "Do not stop at the first qualifying finding. Continue until you've listed every qualifying
finding" *and* "If there is no finding that a person would definitely love to see and fix, prefer
outputting no findings." Claude Code: "do not pad". Cursor: "Prefer a smaller number of high-conviction
comments over a long list of cosmetic notes."

**13. Govern how the comment reads — it is a public comment on a colleague's PR.**
Codex rubric spends a third of its length here (one paragraph, ≤3 lines of code, matter-of-fact, no
flattery, don't overstate severity); Cursor's trust argument ("devs will lose trust in you and stop
listening to you"); Google eng-practices' `Nit:` convention; CodeRabbit `tone_instructions`; Graphite's
"no praise, no unnecessary context, no non-prescriptive verbs".

**14. Anchor tightly. Short line ranges, on the new side, overlapping the diff.**
Codex ("avoid ranges longer than 5–10 lines"); Anthropic plugin's permalink format; your own schema
already says new-side-only but the prompt doesn't repeat the range guidance.

**15. Prefer heterogeneous models, and use the second one as a *gate*, not a second proposer.**
Zhang et al. (heterogeneity is MAD's only reliable win); Refute-or-Promote (cross-family critic catches
correlated training-data errors); Kumar et al. (union ensembles *lower* F1). Corollary from the bias
literature: anonymise attribution, present positions side by side rather than as a rebuttal chain, and
never let the proposer score its own finding.

**16. Where you can, verify by *executing*, not by reasoning harder.**
CodeRabbit generates shell/ast-grep checks "to confirm an assumption or extract proof … before we post
the comment"; Claude Code `ultra` "independently reproduce[s] and verif[ies]" every finding;
Refute-or-Promote's conclusion after a unanimous 80-agent false positive: "One test killed what 80+
agents' reasoning could not."


---

## C. Concrete recommended edits to your three prompts

Ground rules I held to: **the JSON contract is unchanged** (same schema ids, same fields, same enums).
Every edit below either replaces an existing line or inserts a short block. Ordered by expected impact.

### C1 — `review-main.md`: replace the one-line bar with an eight-test bar  ⭐ highest impact

**Current (line 20):**
> `- Material findings only: no naming, style, or "consider extracting". One strong finding beats five weak ones.`

**Replace with:**
```markdown
- Report a finding only if all of these hold. This is the bar, not a vibe:
  1. It meaningfully impacts correctness, security, spec conformance, or maintainability.
  2. It is discrete and actionable — one defect, one location, not "this area is messy".
  3. Fixing it does not demand more rigour than the rest of this codebase already shows.
  4. **This diff introduced it.** Pre-existing defects, and defects on lines this PR did not
     modify, are out of scope even when real.
  5. The author would fix it if they knew about it.
  6. It does not rest on unstated assumptions about the codebase or the author's intent.
  7. If you claim the change breaks something elsewhere, you have *identified* that other code and
     can cite it. Speculation that it "may affect" something is not a finding.
  8. It is clearly not an intentional change by the author.
- Never report what CI already catches: type errors, lint, formatting, missing imports, failing
  tests. Assume those run separately. Never report naming, style, or "consider extracting".
- Do not stop at the first qualifying finding — continue until you have listed every one. Equally,
  do not pad: if nothing clears the bar, return zero findings and say so.
```
*Why:* the current line asks the model to be a good judge of "material" with no operationalisation.
Test 4 (introduced-by-this-diff), test 7 (provably affected, not speculatively) and the CI-exclusion
line are the three that empirically kill the most false positives — they come from Codex's `rubric.md`
and Anthropic's own plugin FP list. The both-ways stopping rule is Codex's; without it, models either
truncate at three findings or pad to the cap.

---

### C2 — `review-main.md`: make `evidence` carry a failure scenario, and calibrate `confidence`  ⭐

**Current (line 19):**
> `- Read the actual code path before asserting. Every finding carries evidence you can point at.`

**Replace with:**
```markdown
- Read the actual code path before asserting — open the enclosing function, not just the hunk.
- `evidence` must name a concrete failure, not restate the claim: the inputs, state, timing, or
  config that trigger it, and the wrong output, crash, or violated invariant that results. If you
  cannot name that trigger, you do not have a finding yet.
- `confidence` is calibrated, not decorative:
  - `0.9–1.0` you traced the path and can name the triggering input and the wrong result.
  - `0.7–0.9` the mechanism is real and you quoted the line; the trigger depends on realistic but
    unverified state (concurrency, cold cache, absent optional field, timeout, config).
  - `0.5–0.7` you believe it but could not rule out a guard elsewhere. Say which guard you looked for.
  - `< 0.5` do not report it.
  Realistic-but-unverified state is not a reason to drop a finding — it is a reason to score it 0.7,
  not 0.9.
```
*Why:* `confidence` is load-bearing in your pipeline — `min_confidence` (default 0.5) drops findings
*before* debate ever sees them — yet nothing in the prompt anchors the scale, so it drifts to a flat
0.8. The anchors mirror Anthropic's 0/25/50/75/100 rubric (which the official plugin ships to the
scoring agent *verbatim*, on purpose) and the recall-biased rubric's list of realistic states.
`failure_scenario` is a separate field in Claude Code's own contract; you can get the same effect
inside `evidence` without touching the schema.

---

### C3 — `review-main.md`: add two finder procedures under the correctness axis  ⭐

**Current (line 12):**
> `1. **Correctness / security** — bugs, broken edge cases, auth/data/idempotency hazards in the changed code.`

**Replace with:**
```markdown
1. **Correctness / security** — bugs, broken edge cases, auth/data/idempotency hazards in the changed
   code. Run these three passes over the diff, in order, and do not let one pass's conclusion
   suppress another's:
   - *Every hunk, line by line.* Then read the enclosing function — a defect on an unchanged line of
     a function this PR touches is in scope. For each line: what input, state, timing, or platform
     makes this line wrong? (inverted condition, off-by-one, null deref, missing `await`,
     falsy-zero, wrong-variable copy-paste, error swallowed in a catch, unanchored regex.)
   - *Every deleted or replaced line.* Name the invariant it enforced, then find where the new code
     re-establishes it. If you cannot find it, that is a finding: a removed guard, a dropped error
     path, a narrowed validation, a deleted test that covered a real case.
   - *Every changed function signature or contract.* Grep its callers and check each call site for a
     new precondition, changed return shape, new exception, or ordering dependency.
```
*Why:* your axes are *categories*; the strongest public prompts give *procedures*. The deleted-line
audit in particular has no analogue in your prompt and is where the expensive regressions live —
Anthropic runs it as a dedicated angle ("Angle B — removed-behavior auditor") at every effort level.

---

### C4 — `review-debate.md`: constrain what counts as a refutation  ⭐⭐ **most important single edit**

**Current (lines 13–17):**
> `Default to skepticism, both ways:`
> `- For each finding: try to **refute** it (the guard already exists, the path is unreachable, the spec says otherwise, the line is misread). If you can't refute it but it's overstated, **downgrade** it. Only **confirm** when you checked the code path yourself and it holds.`

**Replace with:**
```markdown
Default to skepticism, both ways. The three verdicts are not symmetric — `refute` has the highest bar:

- **refute** only when the refutation is constructible from the code and you can show it: the claim
  is factually wrong (quote the actual line), it is provably impossible (show the type, constant, or
  invariant), it is already guarded (cite the guard), or it is pure style with no observable effect.
- **downgrade** when the defect is real but the severity or confidence is overstated.
- **confirm** when you traced the code path yourself and it holds.

Do **not** refute a finding merely for being speculative or "dependent on runtime state" when that
state is realistic — concurrency races, null on a rare-but-reachable path (error handler, cold cache,
absent optional field), falsy-zero treated as missing, off-by-one on a boundary the code does not
exclude, retry storms and partial failures, a regex or allowlist that lost an anchor. Those are
`confirm` or `downgrade`, never `refute`.

Re-read the code yourself. Do not treat the main reviewer's quoted evidence as proof that the line
says what it says.
```
*Why:* this is the failure mode that will cost you real bugs. An unconstrained "try to refute it"
instruction plus a model's natural agreeableness produces confident refutations of true findings, and
your pipeline turns those into `withdrawn` — silently, since withdrawn findings are never posted.
Anthropic ships exactly this asymmetry (REFUTED "only when constructible from the code"; PLAUSIBLE by
default for realistic state) as the fix. The last line is from OpenAI's stop-gate prompt: *"Do not
treat the previous Claude response as proof… verify that from the repository state."*

---

### C5 — `review-debate.md`: add a final self-check block

**Insert** after the `Bar` section (after line 28):
```markdown
## Before you emit
Check each verdict and each new finding:
- Is it adversarial rather than stylistic?
- Is it tied to a concrete code location you actually read?
- Is it plausible under a real failure scenario you can state?
- Is it actionable for the engineer who has to fix it?
Drop anything that fails one of these. Do not let a verdict on `F*` suppress a new `D*` finding at
the same location for a different reason — record both.
```
*Why:* the `<final_check>` block is the one part of OpenAI's `adversarial-review.md` your adaptation
dropped, and it is nearly free. The anti-suppression sentence is Anthropic's cross-angle rule; without
it a debate reviewer that just refuted `F3` at `foo.py:42` tends not to raise its own issue there.

---

### C6 — `review-rebuttal.md`: make withdrawal require a positive reason  ⭐⭐

**Current (lines 11–13):**
> `- Re-check the code for every `refute` and `downgrade` before deciding. If debate is right → `withdrawn`. If debate is wrong and you can show why → `contested`, with the why in `debate_note`. Apply accepted downgrades to `severity`.`

**Replace with:**
```markdown
- Re-check the code for every `refute` and `downgrade` before deciding. `withdrawn` requires a
  positive reason of your own: name the line, guard, type, or spec clause that makes your original
  claim wrong, and put it in `debate_note`. "The debate reviewer disagreed" is not a reason to
  withdraw, and neither is the absence of a counter-argument. If debate is wrong and you can show
  why → `contested`, with the why in `debate_note`. Apply accepted downgrades to `severity`.
- You are expected to hold at least some ground. Withdrawing everything debate challenged means you
  did not re-read the code — go back and do it.
```
*Why:* the documented failure of two-model debate is not stubbornness, it is capitulation. Choi, Zhu &
Li (arXiv:2510.07517) find identity bias in multi-agent debate is "widespread, with **sycophancy far
more common than self-bias**". Your rebuttal pass is where that lands, and a `withdrawn` finding is
never posted, so the failure is invisible. The `claude-devils-advocate` prompt handles it with a
structural quota: *"The Author MUST push back on at least one point per round rather than immediately
conceding everything."*

---

### C7 — `review-rebuttal.md`: hold `D*` findings to the same bar as `F*`

**Current (lines 14–15):**
> `- For each `D*` finding: verify it yourself. Holds → `agreed`. Doesn't → `contested` with your evidence in `debate_note`. Never `withdrawn` for a `D*` you merely dislike.`

**Replace with:**
```markdown
- For each `D*` finding: verify it yourself against the same bar you applied to your own — introduced
  by this diff, discrete and actionable, evidence that names a trigger and a wrong result, not
  something CI catches. Holds → `agreed`. Doesn't → `contested` with your evidence in `debate_note`.
  Never `withdrawn` for a `D*` you merely dislike. If a `D*` restates one of your findings at the same
  location for the same reason, keep yours and mark the `D*` `withdrawn` with "duplicate of F<n>".
```
*Why:* new findings arrive after the bar was set and tend to skip it — they read as fresh insight. The
duplicate clause is from `adversarial-review`'s meta phase (`"DUPLICATE": Already covered in my
original review`); without it your posted review can carry two inline comments on the same line.

---

### C8 — `review-main.md`: comment craft, since these land as inline PR comments

**Insert** into the `Bar` section:
```markdown
- `claim` and `recommendation` are read as an inline comment on someone's PR. One paragraph, no
  code block over three lines, matter-of-fact and not accusatory, no flattery or preamble. State
  plainly which inputs or environments the problem depends on — do not imply it always fires when it
  does not. Never inflate severity: a `blocking` label on something that is not blocking costs you
  every future review.
```
*Why:* nothing in your three prompts governs how the finding *reads*, yet the output is a public
comment on a colleague's PR. Codex's rubric spends a third of its length here. Cursor's
`thermo-nuclear-review` names the consequence directly: *"If you report issues as High priority when
they are not in fact high priority / meaningful issues, devs will lose trust in you and stop listening
to you over time."*

---

### C9 — `review-main.md`: tighten line anchoring

**Current (line 21):**
> `- Anchor `line_start`/`line_end` to lines in the diff's new side.`

**Replace with:**
```markdown
- Anchor `line_start`/`line_end` to lines in the diff's new side, and keep the range as short as the
  problem allows — prefer the single line or the two or three that show it. Avoid ranges over 5–10
  lines; pick the subrange that pinpoints the defect. If the defect is outside the diff, anchor to
  the nearest changed line and say so in `evidence`.
```
*Why:* Codex's rubric spells this out because wide ranges make inline comments land in the wrong place
and read as vague. Your `references/schema.md` already documents the out-of-diff fallback; the prompt
should say it too, since the prompt is what the model reads.

---

### C10 — `review-debate.md`: stop naming the peer

**Current (lines 1–2):**
> `You are the **debate reviewer**. Another model reviewed this pull request and produced the findings below.`

**Replace with:**
```markdown
You are the **debate reviewer**. A prior review pass produced the findings below. Judge them on the
code, not on who wrote them — treat every claim as unattributed.
```
*Why:* small, cheap, and evidence-backed. Choi, Zhu & Li's mitigation for identity bias in multi-agent
debate is exactly this: strip identity markers so agents reason from content. "Another model" is an
identity marker, and in your setup the debate lane often *is* a different vendor's model, which is
precisely the condition that triggers the bias.

---

### C11 — small, cheap consistency fixes

- `review-main.md` line 22: `` `verdict: approve` only if nothing blocking remains `` — add: *"and
  `verdict` is about this diff shipping, not about whether you found anything. Zero findings and
  `approve` is the correct answer for a clean diff; say so in one sentence rather than manufacturing
  a non-blocking observation to fill the array."*
- `review-main.md` line 15 (standards axis): after "Cite file + rule", add *"quote the exact rule text
  and the exact line that breaks it — no 'spirit of the doc' inferences. Do not invent findings
  merely because a standards file exists."* (Anthropic's conventions dimension + Codex's Repository
  Rule Attribution both carry this guard.)
- `review-rebuttal.md` line 17 (`summary`): add *"and state how the debate moved things — how many
  findings were withdrawn, downgraded, or added."* One clause, and it makes debate-collapse visible in
  the posted review instead of buried in `run.json`. (`agent-review-panel`'s post-mortem: *"Debate-skip
  must be loud, not silent."*)

---

### C12 — one architectural caveat you should know before adopting the above

Three of your edits above are prompt-level and safe. This one is not a prompt edit, and I'd be doing
you a disservice to bury it: **the debate reviewer's `new_findings` array is the part of your design
the literature argues against.**

Kumar et al. measured union ensembles directly across five models and found every two-model union
scored *lower* F1 than the better single model — "the models largely detect the same bugs; adding a
second model introduces its false positives without meaningfully increasing true positives." Your `D*`
findings are exactly a union: they enter the pipeline with no independent verification pass, and your
rebuttal prompt currently asks main to "verify it yourself" using a weaker bar than it applied to `F*`
(which C7 fixes, partially).

Meanwhile every high-precision result in the literature — Refute-or-Promote (79–83% killed), QASecClaw
(88.6% of FPs removed at 3.1% recall cost), LLM4PFA (94–98% removed, recall ≥0.86) — comes from using
the second model purely as a **gate**. Your `verdicts` array is already that gate, and it's the strong
half of your design.

Three options, cheapest first, none of which change the JSON contract:

1. **Keep `D*` but hold it to a higher bar than `F*`, not a lower one.** In `review-debate.md`, cap it:
   *"Add a new finding only when it is blocking-severity and you can name the trigger and the wrong
   result. Non-blocking new findings are out of scope for this pass — the main reviewer already swept
   for those. Zero new findings is the expected outcome on most PRs."* This preserves the "attack
   where main didn't look" value for the expensive failures (auth, data loss, migrations) while
   removing the long tail that drives the F1 loss.
2. **Post `D*` findings only when main marks them `agreed`, and mark them visibly as second-pass.**
   You already have `debate_note`; use it.
3. **Add a `--no-new-findings` flag** for repos where noise matters more than recall, running the
   debate lane purely as a verdict gate.

I'd do (1) now — it's one paragraph — and treat (3) as a later flag.

Two smaller architecture notes in the same vein:

- **Sycophancy is worse in sequential rebuttal than in side-by-side presentation** (Kim & Khashabi).
  Your `review-rebuttal.md` is a sequential rebuttal chain, which is the most susceptible format, and
  the same paper finds that a *well-argued but wrong* rebuttal is the most persuasive kind. C6 is the
  prompt-level mitigation; the structural one would be to hand the rebuttal pass main's original
  finding and debate's verdict as two labelled, unattributed positions rather than as "here is what
  the other reviewer said about your work."
- **Fail open, not closed.** QASecClaw retains the original finding when the filter errors, times out,
  or returns malformed output. Worth checking that `review-pr.mjs` does the same when the debate lane
  fails to produce valid JSON — the safe default is to post main's findings unchanged, not to drop the
  run.

### C13 — what I would *not* change

- The JSON contract. It is better-specified than most of the corpus, and `axis` + `severity` +
  `confidence` + `status` covers everything the vendor products expose.
- The single-review, `event: COMMENT`, never-approve posting policy. Correct and non-obvious.
- The `contested` status. Nobody else has a way to post "both models looked and disagreed", and it is
  more honest than silently picking a winner. Cursor's public `bugbot-triage.md` (`fix` / `dismiss` /
  `ask`, with an "Ask by default" list for security, privacy, auth, billing, migrations, concurrency)
  is a good model if you ever want to tier it.
- The `min_confidence` pre-debate drop. Just anchor the scale (C2) so the threshold means something.

---

## D. What I could not find

**Cursor's "nuclear review" — the user is right, but the name is *thermo-nuclear*, and it is not a
setting.** It is a pair of manually-invoked skills in the public MIT-licensed
[cursor/plugins](https://github.com/cursor/plugins) repo — `thermo-nuclear-review` (security +
correctness) and `thermo-nuclear-code-quality-review` (maintainability), orchestrated in parallel by
the `thermos` plugin, both marked `disable-model-invocation: true`. Full prompt text is public and
quoted in §A11. There is **no** review-depth setting named "nuclear", "max", or "ultra" anywhere in
Cursor's product: Bugbot has *Default / High / Custom* effort, and Agent Review has *Quick / Deep*.
(Claude Code's `/code-review` is the thing that has `max` and `ultra` — possibly the source of the
crossed wires.)

**Cursor Bugbot's actual prompt — not public.** Verified absent from all three major leaked-prompt
collections (`elder-plinius/CL4R1T4S`, `x1xhlol/system-prompts-and-models-of-ai-tools`,
`lucasmrdt/TheBigPromptLibrary` carry only Cursor's *IDE agent* prompts; zero hits for "bugbot"). Docs
describe `.cursor/BUGBOT.md`, rule precedence, and effort levels; the blog describes the pipeline. Note
also that Cursor project rules (`.cursor/rules/*.mdc`) explicitly **do not** apply to Bugbot runs.

**Greptile's prompt — not public.** Docs describe `strictness: 1|2|3`, `commentTypes`
(`logic|syntax|style`), `.greptile/config.json` rules with per-rule severity and glob scope, and the
learning loop ("Greptile reads the first and last commit of every PR to see which comments were
addressed"). No prompt text published.

**Graphite Diamond's prompt — not public**, and Diamond has been rebranded ("Graphite Agent" /
"AI Reviews"); `diamond.graphite.dev` now redirects. Their
[AI review customization](https://graphite.com/docs/ai-review-customization) page is the closest thing
— a prompt-*writing* style guide, quoted in §A13.

**CodeRabbit's prompt — not public**, and the premise that it has a `reviews.instructions` field is
wrong: there is no global free-text instruction knob, only `tone_instructions` (250 chars),
glob-scoped `path_instructions` (20k each), and the various custom-check / label / summary instruction
fields. Verified against their public JSON schema.

**Codex's *cloud/GitHub* review wrapper — not public.** The CLI's reviewer is fully open source
(`codex-rs/prompts/templates/review/rubric.md`, Apache-2.0, quoted in full in §A9), but whatever the
GitHub integration layers on top — the P0/P1-only filter and the PR-comment formatting — is described
in docs only. Note the path in the brief, `codex-rs/core/src/review_prompt.md`, **does not exist**; the
file moved (it was at `codex-rs/core/review_prompt.md` as of tag `rust-v0.45.0`).

**Claude Code's built-in `/code-review` skill — not officially published.** The prompt text quoted in
§A1 comes from two independent extractions of the shipped binary — the community
`Piebald-AI/claude-code-system-prompts` repo, and a direct extraction from the local install
(v2.1.238) that agreed with it. Anthropic's docs describe behaviour and never quote the prompt. Treat
it as accurate-but-unofficial. The `plugins/code-review` and `pr-review-toolkit` prompts *are* official
and public.

**No Simon Willison or swyx / Latent.Space piece specifically on AI-code-review prompting or noise.**
This was in the brief and I could not verify one exists. Willison's code-review-adjacent writing is
about reviewing *agent-written* code (don't file PRs with code you haven't read yourself), and his
[note on Hamel's LLM-as-judge post](https://simonwillison.net/2024/Oct/30/llm-as-a-judge/) is the
closest hit. Hamel Husain's evals material *is* directly useful and is cited in §A16. I did not invent
a citation to fill the gap.

**No "awesome-prompts"-style repo worth citing.** The PR-review prompts in those collections are
generic ("review this code for bugs, security, and performance") and strictly worse than everything in
§A. The community prompts that *are* worth reading are the four in §A5–A7.

**Papers whose figures I deliberately did not quote:** Sphinx ([arXiv:2601.04252](https://arxiv.org/pdf/2601.04252)),
"The Confident Liar" (2606.10296), "Voting or Consensus?" (2502.19130), and "Heterogeneous LLM Debate
Under Adversarial Peers" (2606.19826). All four exist with the stated authors and dates, but their
tables did not extract cleanly, so no numbers from them appear above.

---

## Appendix — one-line source index

| Source | Prompt public? | Where |
|---|---|---|
| Claude Code `/code-review` (built-in) | Unofficial extraction | [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) |
| Claude Code `/security-review` | ✅ Yes | [anthropics/claude-code-security-review](https://github.com/anthropics/claude-code-security-review) |
| Anthropic `code-review` plugin | ✅ Yes | [anthropics/claude-code `plugins/code-review`](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md) |
| Anthropic `pr-review-toolkit` | ✅ Yes | claude-plugins-official marketplace (installed locally) |
| `claude-code-action` | ✅ Yes | [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) |
| Anthropic managed Code Review | ❌ Docs only | [code.claude.com/docs/en/code-review](https://code.claude.com/docs/en/code-review) |
| Codex CLI `codex review` | ✅ Yes (Apache-2.0) | [`review/rubric.md`](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/review/rubric.md) |
| Codex cloud / GitHub review | ❌ Docs only | [learn.chatgpt.com/docs/third-party/github](https://learn.chatgpt.com/docs/third-party/github) |
| `codex-plugin-cc` adversarial-review | ✅ Yes | [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc/blob/main/plugins/codex/prompts/adversarial-review.md) |
| Cursor `thermo-nuclear-review` | ✅ Yes (MIT) | [cursor/plugins](https://github.com/cursor/plugins/blob/main/thermos/skills/thermo-nuclear-review/SKILL.md) |
| Cursor Bugbot | ❌ Docs only | [cursor.com/docs/bugbot](https://cursor.com/docs/bugbot) |
| Greptile | ❌ Docs only | [greptile.com/docs](https://www.greptile.com/docs/code-review/controlling-nitpickiness) |
| Graphite AI Reviews | ❌ Docs only | [graphite.com/docs/ai-review-customization](https://graphite.com/docs/ai-review-customization) |
| CodeRabbit | ❌ Config schema only | [schema.v2.json](https://storage.googleapis.com/coderabbit_public_assets/schema.v2.json) |
| `alecnielsen/adversarial-review` | ✅ Yes | [github.com/alecnielsen/adversarial-review](https://github.com/alecnielsen/adversarial-review) |
| `claude-devils-advocate` | ✅ Yes | [github.com/richiethomas/claude-devils-advocate](https://github.com/richiethomas/claude-devils-advocate) |
| `agent-review-panel` | ✅ Yes | [github.com/wan-huiyan/agent-review-panel](https://github.com/wan-huiyan/agent-review-panel) |
| Google eng-practices | n/a (human guide) | [google.github.io/eng-practices](https://google.github.io/eng-practices/review/reviewer/standard.html) |
