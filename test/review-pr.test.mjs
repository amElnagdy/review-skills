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

test('on-pr-created: ignores non-PR commands, does not start anything', () => {
  const hook = path.join(ROOT, 'skills/debate-review/scripts/on-pr-created.mjs');
  const r = spawnSync('node', [hook], { input: JSON.stringify({ tool_input: { command: 'git status' }, tool_response: 'clean' }), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const r2 = spawnSync('node', [hook], { input: 'not json', encoding: 'utf8' });
  assert.equal(r2.status, 0);
});

test('review-pr: usage errors exit 2', () => {
  const script = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
  assert.equal(spawnSync('node', [script], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [script, '1', '--contested', 'maybe'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('node', [script, '--help'], { encoding: 'utf8' }).status, 0);
});
