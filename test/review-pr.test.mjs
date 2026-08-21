import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTarget, parseOrigin } from '../skills/debate-review/scripts/lib/forge.mjs';
import { diffLineMap, anchor } from '../skills/debate-review/scripts/lib/diff.mjs';
import { extractJson, expectSchema } from '../skills/debate-review/scripts/lib/dispatch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parseTarget: github url, gitlab url, bare number via origin', () => {
  assert.deepEqual(parseTarget('https://github.com/amElnagdy/delegate-skills/pull/81'),
    { host: 'github', origin: 'github.com', owner: 'amElnagdy', repo: 'delegate-skills', number: 81 });
  assert.deepEqual(parseTarget('https://git.example.com/grp/sub/proj/-/merge_requests/7'),
    { host: 'gitlab', origin: 'git.example.com', owner: 'grp/sub', repo: 'proj', number: 7 });
  assert.deepEqual(parseTarget('12', 'git@github.com:amElnagdy/togi-app.git'),
    { host: 'github', origin: 'github.com', owner: 'amElnagdy', repo: 'togi-app', number: 12 });
  assert.equal(parseOrigin('https://gitlab.com/a/b/c.git').owner, 'a/b');
  assert.throws(() => parseTarget('nope'));
});

test('diffLineMap + anchor: context and added lines are commentable, removed are not', () => {
  const diff = [
    'diff --git a/x.py b/x.py', '--- a/x.py', '+++ b/x.py',
    '@@ -10,4 +10,5 @@ def f():', ' a', '-old', '+new1', '+new2', ' b', ' c',
    'diff --git a/gone.py b/gone.py', '--- a/gone.py', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y',
  ].join('\n');
  const map = diffLineMap(diff);
  assert.deepEqual([...map.get('x.py')], [10, 11, 12, 13, 14]);
  assert.equal(map.has('gone.py'), false);
  assert.deepEqual(anchor(map, { file: 'x.py', line_start: 11, line_end: 12 }), { path: 'x.py', line: 12, start_line: 11, snapped: false });
  assert.deepEqual(anchor(map, { file: 'x.py', line_start: 40, line_end: 40 }), { path: 'x.py', line: 14, start_line: undefined, snapped: true });
  assert.equal(anchor(map, { file: 'other.py', line_start: 1, line_end: 1 }), null);
});

test('extractJson + expectSchema', () => {
  assert.deepEqual(extractJson('text ```json\n{"a":1}\n``` more ```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('prose {"schema":"x"} trailing'), { schema: 'x' });
  assert.throws(() => extractJson('nothing here'));
  assert.throws(() => expectSchema({ schema: 'wrong' }, 'debate-review.findings.v1', 'main'));
});

test('review-pr: usage errors exit 2', () => {
  const script = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
  assert.equal(spawnSync('node', [script], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [script, '1', '--contested', 'maybe'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [script, '--help'], { encoding: 'utf8' }).status, 0);
});

test('validate: contract checks fail closed and fill missing verdicts', async () => {
  const { validateFindings, validateDebate, validateFinal } = await import('../skills/debate-review/scripts/lib/validate.mjs');
  const f = (id, extra = {}) => ({ id, file: 'a.py', line_start: 3, line_end: 4, severity: 'blocking', claim: 'x', confidence: 0.8, ...extra });
  const findings = validateFindings({ schema: 'debate-review.findings.v1', verdict: 'needs-attention', findings: [f('F1'), f('F2')] });
  assert.throws(() => validateFindings({ schema: 'debate-review.findings.v1', verdict: 'approve', findings: [f('F1', { severity: 'p1' })] }), /severity/);
  assert.throws(() => validateFindings({ schema: 'debate-review.findings.v1', verdict: 'approve', findings: [f('F1'), f('F1')] }), /duplicate/);

  const debate = validateDebate({ schema: 'debate-review.debate.v1', verdicts: [{ id: 'F1', verdict: 'refute', reason: 'r', evidence: 'e' }], new_findings: [f('D1')] }, findings);
  assert.deepEqual(debate.verdicts.map(v => `${v.id}:${v.verdict}`), ['F1:refute', 'F2:confirm']); // F2 filled as "no objection"
  assert.throws(() => validateDebate({ schema: 'debate-review.debate.v1', verdicts: [{ id: 'F9', verdict: 'confirm' }] }, findings), /unknown finding/);
  assert.throws(() => validateDebate({ schema: 'debate-review.debate.v1', verdicts: [{ id: 'F1', verdict: 'confirm' }, { id: 'F1', verdict: 'refute' }] }, findings), /more than one/);

  const ok = [f('F1', { status: 'withdrawn' }), f('F2', { status: 'agreed' }), f('D1', { status: 'agreed' })];
  validateFinal({ schema: 'debate-review.final.v1', findings: ok }, findings, debate);
  assert.throws(() => validateFinal({ schema: 'debate-review.final.v1', findings: ok.slice(0, 2) }, findings, debate), /dropped silently/);
  assert.throws(() => validateFinal({ schema: 'debate-review.final.v1', findings: [...ok, f('F7', { status: 'agreed' })] }, findings, debate), /from nowhere/);
  assert.throws(() => validateFinal({ schema: 'debate-review.final.v1', findings: [ok[0], ok[1], f('D1', { status: 'contested' })] }, findings, debate), /cannot be contested/);
});

