import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, parseOrigin, diffLineMap, anchor, extractJson } from '../skills/debate-review/scripts/review-pr.mjs';

test('parseTarget: github url, gitlab url, bare number via origin', () => {
  assert.deepEqual(parseTarget('https://github.com/amElnagdy/delegate-skills/pull/81'), { host: 'github', origin: 'github.com', owner: 'amElnagdy', repo: 'delegate-skills', number: 81 });
  assert.deepEqual(parseTarget('https://git.example.com/grp/sub/proj/-/merge_requests/7'), { host: 'gitlab', origin: 'git.example.com', owner: 'grp/sub', repo: 'proj', number: 7 });
  assert.deepEqual(parseTarget('12', 'git@github.com:amElnagdy/togi-app.git'), { host: 'github', origin: 'github.com', owner: 'amElnagdy', repo: 'togi-app', number: 12 });
  assert.equal(parseOrigin('https://gitlab.com/a/b/c.git').owner, 'a/b');
  assert.throws(() => parseTarget('nope'));
});

test('diffLineMap + anchor: context and added lines are commentable, removed are not', () => {
  const diff = [
    'diff --git a/x.py b/x.py', '--- a/x.py', '+++ b/x.py',
    '@@ -10,4 +10,5 @@ def f():', ' a', '-old', '+new1', '+new2', ' b', ' c',
    'diff --git a/gone.py b/gone.py', '--- a/gone.py', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y',
  ].join('\n');
  const m = diffLineMap(diff);
  assert.deepEqual([...m.get('x.py')], [10, 11, 12, 13, 14]);
  assert.equal(m.has('gone.py'), false);
  assert.deepEqual(anchor(m, { file: 'x.py', line_start: 11, line_end: 12 }), { path: 'x.py', line: 12, start_line: 11, snapped: false });
  assert.deepEqual(anchor(m, { file: 'x.py', line_start: 40, line_end: 40 }), { path: 'x.py', line: 14, start_line: undefined, snapped: true });
  assert.equal(anchor(m, { file: 'other.py', line_start: 1, line_end: 1 }), null);
});

test('extractJson: last fenced block wins, bare object fallback', () => {
  assert.deepEqual(extractJson('text ```json\n{"a":1}\n``` more ```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('prose {"schema":"x"} trailing'), { schema: 'x' });
  assert.throws(() => extractJson('nothing here'));
});
