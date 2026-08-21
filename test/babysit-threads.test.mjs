import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fsMod from 'node:fs';
import osMod from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skills/babysit-pr/scripts/threads.sh');
const FIXTURES = path.join(ROOT, 'test/fixtures/babysit');

function harvest(args) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(FIXTURES, 'bin')}:${process.env.PATH}`, FIXTURES },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const KEYS = ['thread_id', 'reply_to', 'resolved', 'resolvable', 'outdated', 'author', 'author_bot', 'author_is_pr_author',
  'path', 'line', 'original_line', 'line_side', 'position_head', 'comment_count', 'body', 'last_author', 'last_body',
  'source', 'debate_id', 'debate_status', 'debate_severity', 'debate_review'];

test('threads.sh github: whole script against a fake gh', () => {
  const out = harvest(['7', 'acme/app', '--github']);
  assert.equal(out.forge, 'github');
  assert.equal(out.head, 'aaaa1111');
  assert.equal(out.pr_author, 'alice');
  assert.deepEqual(out.capabilities, { outdated: true, review_commit_id: true, author_bot_flag: true });
  assert.equal(out.threads.length, 3);
  for (const k of KEYS) assert.ok(k in out.threads[0], `missing ${k}`);
  const [t1, t2, t3] = out.threads;
  assert.deepEqual([t1.debate_review, t1.debate_id, t1.debate_status, t1.debate_severity, t1.debate_level], [true, 'F1', 'agreed', 'blocking', 'P1']);
  assert.equal(t1.author_is_pr_author, true);        // posted from the user's account, still a reviewer thread
  assert.deepEqual([t2.author_bot, t2.outdated, t2.line, t2.resolved], [true, true, 40, true]);
  assert.deepEqual([t3.debate_review, t3.author_bot, t3.line_side], [false, false, 'LEFT']);
  assert.equal(out.unresolved, 2);
  assert.equal(out.reviews.length, 2);               // the empty-body Codex wrapper is dropped
  const body = out.reviews.find(r => r.debate_review);
  assert.deepEqual([body.debate_head, body.debate_agreed, body.debate_contested, body.source], ['aaaa1111', 1, 0, 'review']);
});

test('threads.sh gitlab: same shape, individual notes and system notes excluded, no double counting', () => {
  const out = harvest(['45', 'grp/proj', '--gitlab', '--hostname', 'gitlab.example.com']);
  assert.equal(out.forge, 'gitlab');
  assert.equal(out.host, 'gitlab.example.com');
  assert.equal(out.head, 'bbbb2222');
  assert.equal(out.pr_author, 'nagdy');
  assert.deepEqual(out.capabilities, { outdated: false, review_commit_id: false, author_bot_flag: false });
  for (const k of KEYS) assert.ok(k in out.threads[0], `missing ${k}`);
  assert.deepEqual(out.threads.map(t => t.thread_id), ['d1', 'd4']);   // d2 individual note, d3 system note
  const [d1, d4] = out.threads;
  assert.deepEqual([d1.debate_status, d1.debate_level, d1.path, d1.line, d1.line_side, d1.position_head, d1.comment_count, d1.last_author],
    ['contested', null, 'lib/x.rb', 7, 'new', 'bbbb2222', 2, 'bob']);   // old-format marker (no level) still parses
  assert.equal(d1.outdated, null);
  assert.deepEqual([d4.author_bot, d4.resolved, d4.path, d4.note_type], [true, true, null, 'DiscussionNote']);
  assert.equal(out.unresolved, 1);
  // reviews: note 3 (plain comment) and note 6 (debate body). Notes 1/5 are thread roots, 4 is system.
  assert.deepEqual(out.reviews.map(r => r.id), [3, 6]);
  const body = out.reviews.find(r => r.debate_review);
  assert.deepEqual([body.debate_head, body.debate_agreed, body.debate_contested, body.source, body.commit_id], ['bbbb2222', 0, 1, 'note', null]);
});

test('threads.sh: usage error without a number', () => {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('threads.sh: forge, repo and host come from the git origin when not given', () => {
  const fs = require_fs();
  const os = require_os();
  for (const [origin, expect] of [
    ['git@github.com:acme/app.git', { forge: 'github', repo: 'acme/app', host: 'github.com' }],
    ['https://gitlab.example.com/grp/proj.git', { forge: 'gitlab', repo: 'grp/proj', host: 'gitlab.example.com' }],
    ['ssh://git@gitlab.example.com/grp/sub/proj', { forge: 'gitlab', repo: 'grp/sub/proj', host: 'gitlab.example.com' }],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-origin-'));
    spawnSync('git', ['-C', dir, 'init', '-q']);
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
    const r = spawnSync('bash', [SCRIPT, expect.forge === 'github' ? '7' : '45'], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(FIXTURES, 'bin')}:${process.env.PATH}`, FIXTURES },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual({ forge: out.forge, repo: out.repo, host: out.host }, expect, origin);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function require_fs() { return fsMod; }
function require_os() { return osMod; }
