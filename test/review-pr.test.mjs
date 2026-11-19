import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTarget, parseOrigin, cloneUrl, gitAuth, fetchPR, alreadyReviewed, fetchSpec, postReview } from '../skills/debate-review/scripts/lib/forge.mjs';
import { diffLineMap, anchor } from '../skills/debate-review/scripts/lib/diff.mjs';
import { extractJson, expectSchema, dispatch } from '../skills/debate-review/scripts/lib/dispatch.mjs';
import { makeWorktree } from '../skills/debate-review/scripts/review-pr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parseTarget: github url, gitlab url, bare number via origin', () => {
  assert.deepEqual(parseTarget('https://github.com/amElnagdy/delegate-skills/pull/81'),
    { host: 'github', origin: 'github.com', owner: 'amElnagdy', repo: 'delegate-skills', number: 81 });
  assert.deepEqual(parseTarget('https://git.example.com/grp/sub/proj/-/merge_requests/7'),
    { host: 'gitlab', origin: 'git.example.com', owner: 'grp/sub', repo: 'proj', number: 7 });
  assert.deepEqual(parseTarget('12', 'git@github.com:amElnagdy/togi-app.git'),
    { host: 'github', origin: 'github.com', owner: 'amElnagdy', repo: 'togi-app', number: 12 });
  assert.equal(parseOrigin('https://gitlab.com/a/b/c.git').owner, 'a/b');
  assert.equal(parseOrigin('git@git.example.com:2024/handbook.git').owner, '2024');
  assert.throws(() => parseTarget('nope'));
});

test('parseTarget: azure devops urls, with and without the project segment', () => {
  const full = { host: 'azure', origin: 'dev.azure.com', org: 'wscegy', project: 'Kultura', owner: 'wscegy/Kultura', repo: 'kultura-mobile', number: 1845 };
  assert.deepEqual(parseTarget('https://dev.azure.com/wscegy/Kultura/_git/kultura-mobile/pullrequest/1845'), full);
  assert.deepEqual(parseTarget('https://dev.azure.com/wscegy/Kultura/_git/kultura-mobile/pullRequest/1845?_a=files'), full);
  // project omitted in the url: Azure DevOps means "the project named like the repo"
  assert.deepEqual(parseTarget('https://dev.azure.com/wscegy/_git/tools/pullrequest/9'),
    { host: 'azure', origin: 'dev.azure.com', org: 'wscegy', project: 'tools', owner: 'wscegy/tools', repo: 'tools', number: 9 });
  // legacy host, and a project name that had to be percent-encoded
  assert.deepEqual(parseTarget('https://wscegy.visualstudio.com/My%20Team/_git/app/pullrequest/3'),
    { host: 'azure', origin: 'dev.azure.com', org: 'wscegy', project: 'My Team', owner: 'wscegy/My Team', repo: 'app', number: 3 });
  assert.deepEqual(parseTarget('https://wscegy.visualstudio.com/DefaultCollection/My%20Team/_git/app/pullrequest/3'),
    { host: 'azure', origin: 'dev.azure.com', org: 'wscegy', project: 'My Team', owner: 'wscegy/My Team', repo: 'app', number: 3 });
  assert.deepEqual(parseTarget('https://wscegy.visualstudio.com/DefaultCollection/_git/app/pullrequest/3'),
    { host: 'azure', origin: 'dev.azure.com', org: 'wscegy', project: 'app', owner: 'wscegy/app', repo: 'app', number: 3 });
});

test('parseOrigin: azure devops remotes (https with userinfo, ssh v3, legacy) and the clone url', () => {
  const expected = { host: 'azure', origin: 'dev.azure.com', org: 'wscegy', project: 'Kultura', owner: 'wscegy/Kultura', repo: 'kultura-mobile' };
  assert.deepEqual(parseOrigin('https://wscegy@dev.azure.com/wscegy/Kultura/_git/kultura-mobile'), expected);
  assert.deepEqual(parseOrigin('git@ssh.dev.azure.com:v3/wscegy/Kultura/kultura-mobile'), expected);
  assert.deepEqual(parseOrigin('wscegy@vs-ssh.visualstudio.com:v3/wscegy/Kultura/kultura-mobile'), expected);
  assert.deepEqual(parseOrigin('ssh://wscegy@vs-ssh.visualstudio.com:22/v3/wscegy/Kultura/kultura-mobile'), expected);
  assert.deepEqual(parseOrigin('git@ssh.dev.azure.com:v3/wscegy/My%20Team/kultura-mobile'),
    { ...expected, project: 'My Team', owner: 'wscegy/My Team' });
  assert.deepEqual(parseOrigin('https://wscegy.visualstudio.com/Kultura/_git/kultura-mobile'), expected);
  assert.deepEqual(parseOrigin('https://wscegy.visualstudio.com/DefaultCollection/Kultura/_git/kultura-mobile'), expected);
  assert.deepEqual(parseOrigin('https://wscegy.visualstudio.com/DefaultCollection/_git/kultura-mobile'),
    { ...expected, project: 'kultura-mobile', owner: 'wscegy/kultura-mobile' });
  assert.deepEqual(parseTarget('1845', 'https://wscegy@dev.azure.com/wscegy/Kultura/_git/kultura-mobile'), { ...expected, number: 1845 });
  assert.equal(cloneUrl(expected), 'https://dev.azure.com/wscegy/Kultura/_git/kultura-mobile');
  assert.equal(cloneUrl({ host: 'github', origin: 'github.com', owner: 'a', repo: 'b' }), 'https://github.com/a/b.git');
  // a github remote must not be read as azure just because it has userinfo
  assert.equal(parseOrigin('https://token@github.com/a/b.git').host, 'github');
});

test('azure: read the pr, spot an existing review, post threads (fake az)', () => {
  const FIXTURES = path.join(ROOT, 'test/fixtures');
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'debate-review-test-')), 'posted.ndjson');
  const saved = { PATH: process.env.PATH, FIXTURES: process.env.FIXTURES, AZ_LOG: process.env.AZ_LOG, AZ_NO_TARGET: process.env.AZ_NO_TARGET, AZ_NO_ITERATION: process.env.AZ_NO_ITERATION, AZ_EMPTY_WORK_ITEM: process.env.AZ_EMPTY_WORK_ITEM, AZ_SUMMARY_EXISTS: process.env.AZ_SUMMARY_EXISTS };
  process.env.PATH = `${path.join(FIXTURES, 'azure/bin')}:${process.env.PATH}`;
  process.env.FIXTURES = FIXTURES;
  process.env.AZ_LOG = log;

  try {
    const t = parseTarget('https://dev.azure.com/wscegy/Kultura/_git/kultura-mobile/pullrequest/1845');
    const pr = fetchPR(t);
    assert.equal(pr.head, '49793f1fec6cd58262e25752b79be791c68eb474');
    assert.equal(pr.baseSha, '459026c8ad84bc296a0b44d5c3c1e4bbbbe81592');
    assert.equal(pr.iterationId, 3);
    assert.deepEqual([pr.headRef, pr.baseRef], ['test/TEST-001-revenue-path-coverage', 'dev']);
    assert.deepEqual([pr.fetchRef, pr.fetchRefAlt], ['refs/pull/1845/merge', 'test/TEST-001-revenue-path-coverage']);
    assert.equal(pr.fetchUrlAlt, 'https://dev.azure.com/wscegy/Forks/_git/kultura-mobile-fork');
    assert.equal(pr.url, 'https://dev.azure.com/wscegy/Kultura/_git/kultura-mobile/pullrequest/1845');
    process.env.AZ_NO_ITERATION = '1';
    assert.equal(fetchPR(t).iterationId, undefined);
    delete process.env.AZ_NO_ITERATION;
    process.env.AZ_NO_TARGET = '1';
    assert.throws(() => fetchPR(t), /has no merge commits/);
    delete process.env.AZ_NO_TARGET;

    const auth = gitAuth(t);
    assert.deepEqual(auth.args, [
      '--config-env=http.https://dev.azure.com/.extraheader=DEBATE_REVIEW_AZURE_AUTH',
      '--config-env=http.https://wscegy.visualstudio.com/.extraheader=DEBATE_REVIEW_AZURE_AUTH',
    ]);
    assert.equal(auth.env.DEBATE_REVIEW_AZURE_AUTH, 'AUTHORIZATION: bearer fake-azure-token');
    const azureHeader = spawnSync('git', [...auth.args, 'config', '--get-urlmatch',
      'http.extraheader', 'https://dev.azure.com/wscegy/repo'], { encoding: 'utf8', env: auth.env, cwd: os.tmpdir() });
    const otherHeader = spawnSync('git', [...auth.args, 'config', '--get-urlmatch',
      'http.extraheader', 'https://example.invalid/repo'], { encoding: 'utf8', env: auth.env, cwd: os.tmpdir() });
    const legacyHeader = spawnSync('git', [...auth.args, 'config', '--get-urlmatch',
      'http.extraheader', 'https://wscegy.visualstudio.com/Kultura/_git/repo'],
      { encoding: 'utf8', env: auth.env, cwd: os.tmpdir() });
    assert.equal(azureHeader.stdout.trim(), 'AUTHORIZATION: bearer fake-azure-token');
    assert.equal(legacyHeader.stdout.trim(), 'AUTHORIZATION: bearer fake-azure-token');
    assert.equal(otherHeader.stdout.trim(), '');

    // the fixture carries a marker for a different head sha
    assert.equal(alreadyReviewed(t, pr), false);
    assert.equal(alreadyReviewed(t, { head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }), true);

    // "#4907" is a work item on azure, and its html description is flattened
    const spec = fetchSpec(t, pr, '');
    assert.ok(spec.includes('Work item #4907: TEST-001 revenue path coverage'));
    assert.ok(spec.includes('Cover the revenue path.') && !spec.includes('<b>'));
    assert.ok(spec.includes('Pagination & payment.'));
    process.env.AZ_EMPTY_WORK_ITEM = '1';
    assert.equal(fetchSpec(t, pr, ''), 'none found, skip the Spec axis');
    delete process.env.AZ_EMPTY_WORK_ITEM;

    const result = postReview(t, pr, 'summary body', [
      { path: 'lib/a.dart', line: 12, claim: 'one', body: '<!-- debate-review:F1 status=agreed -->\none' },
      { path: 'lib/b.dart', line: 40, start_line: 38, claim: 'two', body: '<!-- debate-review:F2 status=agreed -->\ntwo' },
      { path: 'lib/missing.dart', line: 8, claim: 'three', body: '<!-- debate-review:F3 status=agreed -->\nthree' },
    ]);
    assert.equal(result.threadIds.length, 3);
    assert.equal(result.threadIds[0], 7020);              // existing F1 thread was reused
    assert.equal(result.url, pr.url);

    const posted = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(posted.length, 3);                       // existing F1 skipped; F2, F3, then summary
    assert.equal(posted[0].threadContext.filePath, '/lib/b.dart');
    assert.deepEqual(posted[0].threadContext.rightFileStart, { line: 38, offset: 1 });
    assert.deepEqual(posted[0].threadContext.rightFileEnd, { line: 40, offset: 1 });
    assert.match(posted[0].comments[0].content,
      /^<!-- debate-review finding=[0-9a-f]{16} head=49793f1f/);
    assert.deepEqual(posted[0].pullRequestThreadContext, {
      changeTrackingId: 12,
      iterationContext: { firstComparingIteration: 3, secondComparingIteration: 3 },
    });
    assert.equal(posted[1].threadContext.filePath, '/lib/missing.dart');
    assert.equal(posted[1].pullRequestThreadContext, undefined);
    assert.equal(posted[2].threadContext, undefined);     // the summary is not anchored to a file
    assert.equal(posted[2].comments[0].content, 'summary body');
    assert.equal(posted[2].status, 'closed');

    const forcedBody = `<!-- debate-review head=${pr.head} main=claude -->\nforced summary`;
    postReview(t, { ...pr, force: true, postAttempt: 'forced-test' }, forcedBody, [
      { path: 'lib/a.dart', line: 12, claim: 'one', body: '<!-- debate-review:F1 status=contested -->\nupdated' },
    ]);
    const forced = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(forced.length, 5);                       // force adds a fresh inline plus summary
    assert.match(forced[3].comments[0].content, /attempt=forced-test/);
    assert.match(forced[3].comments[0].content, /updated$/);
    assert.match(forced[4].comments[0].content, /head=.* attempt=forced-test main=claude/);

    process.env.AZ_SUMMARY_EXISTS = '1';
    const resumed = postReview(t, { ...pr, postAttempt: 'forced-test' }, forcedBody, [
      { path: 'lib/a.dart', line: 12, claim: 'one', body: '<!-- debate-review:F1 status=contested -->\nupdated' },
    ]);
    assert.deepEqual([resumed.threadIds[0], resumed.summaryThreadId], [7021, 7022]);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 5);

    const plain = postReview(t, pr, `<!-- debate-review head=${pr.head} main=claude -->\nplain summary`, []);
    delete process.env.AZ_SUMMARY_EXISTS;
    assert.notEqual(plain.summaryThreadId, 7022);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 6);
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(path.dirname(log), { recursive: true, force: true });
  }
});

test('parseTarget/parseOrigin: GitHub Enterprise hosts are github, not gitlab', () => {
  const bin = path.join(ROOT, 'test/fixtures/forge/bin');
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    // a GHE host cannot be recognised by name, so it is resolved by asking gh
    assert.deepEqual(parseOrigin('https://ghe.example.com/acme/widget.git'),
      { host: 'github', origin: 'ghe.example.com', owner: 'acme', repo: 'widget' });
    assert.deepEqual(parseOrigin('git@ghe.example.com:acme/widget.git'),
      { host: 'github', origin: 'ghe.example.com', owner: 'acme', repo: 'widget' });
    assert.deepEqual(parseTarget('https://ghe.example.com/acme/widget/pull/5'),
      { host: 'github', origin: 'ghe.example.com', owner: 'acme', repo: 'widget', number: 5 });
    assert.deepEqual(parseTarget('5', 'https://ghe.example.com/acme/widget.git'),
      { host: 'github', origin: 'ghe.example.com', owner: 'acme', repo: 'widget', number: 5 });
    // a host gh does not know stays gitlab, and an MR url still wins on its own path
    assert.equal(parseOrigin('https://git.example.com/grp/proj.git').host, 'gitlab');
    assert.equal(parseTarget('https://git.example.com/grp/proj/-/merge_requests/7').host, 'gitlab');
  } finally {
    process.env.PATH = saved;
  }
});

test('diffLineMap + anchor: context and added lines are commentable, removed are not', () => {
  const diff = [
    'diff --git a/x.py b/x.py', '--- a/x.py', '+++ b/x.py',
    '@@ -10,4 +10,5 @@ def f():', ' a', '-old', '+new1', '+new2', ' b', ' c',
    'diff --git a/gone.py b/gone.py', '--- a/gone.py', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y',
  ].join('\n');
  const map = diffLineMap(diff);
  assert.deepEqual([...map.get('x.py').keys()], [10, 11, 12, 13, 14]);
  assert.equal(map.get('x.py').get(10), 10);   // context
  assert.equal(map.get('x.py').get(11), null); // added
  assert.equal(map.get('x.py').get(12), null); // added
  assert.equal(map.get('x.py').get(13), 12);   // context
  assert.equal(map.get('x.py').get(14), 13);   // context
  assert.equal(map.has('gone.py'), false);
  assert.deepEqual(anchor(map, { file: 'x.py', line_start: 11, line_end: 12 }), { path: 'x.py', line: 12, start_line: 11, snapped: false });
  assert.deepEqual(anchor(map, { file: 'x.py', line_start: 40, line_end: 40 }), { path: 'x.py', line: 14, start_line: undefined, old_line: 13, snapped: true });
  assert.equal(anchor(map, { file: 'other.py', line_start: 1, line_end: 1 }), null);
});

test('diffLineMap: +++ inside a hunk is an added line, not a file header', () => {
  const diff = [
    'diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md',
    '@@ -1,3 +1,4 @@', ' # Title', '+++ heading', ' context', ' more',
    'diff --git a/src/app.js b/src/app.js', '--- a/src/app.js', '+++ b/src/app.js',
    '@@ -1,1 +1,2 @@', ' line', '+added',
  ].join('\n');
  const map = diffLineMap(diff);
  assert.equal(map.has('heading'), false);
  assert.deepEqual([...map.get('README.md').keys()], [1, 2, 3, 4]);
  assert.equal(map.get('README.md').get(2), null); // added `++ heading`
  assert.deepEqual([...map.get('src/app.js').keys()], [1, 2]);
});

test('diffLineMap: --- inside a hunk is a removed line, not a file header', () => {
  const diff = [
    'diff --git a/notes.md b/notes.md', '--- a/notes.md', '+++ b/notes.md',
    '@@ -1,2 +1,1 @@', '--- dashdash', ' keep',
    'diff --git a/next.js b/next.js', '--- a/next.js', '+++ b/next.js',
    '@@ -1,1 +1,1 @@', ' ok',
  ].join('\n');
  const map = diffLineMap(diff);
  assert.equal(map.has('dashdash'), false);
  assert.deepEqual([...map.get('notes.md').keys()], [1]);
  assert.deepEqual([...map.get('next.js').keys()], [1]);
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

test('review-pr: --local and --dry-run are separate jobs', () => {
  const script = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
  const spawn = (args) => spawnSync('node', [script, ...args], { encoding: 'utf8' });

  const both = spawn(['--local', '--dry-run']);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /--local/);

  const localWithUrl = spawn(['--local', 'https://github.com/a/b/pull/1']);
  assert.equal(localWithUrl.status, 2);
  assert.match(localWithUrl.stderr, /--local/);

  const dryNoUrl = spawn(['--dry-run']);
  assert.equal(dryNoUrl.status, 2);
  assert.match(dryNoUrl.stderr, /--local/);
});

test('review-pr: --local --repo-dir non-repo exits 1 after parsing', () => {
  const script = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
  const missing = path.join(os.tmpdir(), 'dr-not-a-repo-' + process.pid);
  fs.rmSync(missing, { recursive: true, force: true });
  fs.mkdirSync(missing);
  const result = spawnSync('node', [script, '--local', '--repo-dir', missing], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a git work tree/);
  fs.rmSync(missing, { recursive: true, force: true });
});

test('review-pr: Azure repo-dir rejects a same-named GitLab clone', () => {
  const script = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-forge-mismatch-'));
  const bins = [path.join(ROOT, 'test/fixtures/forge/bin'), path.join(ROOT, 'test/fixtures/azure/bin')];
  const env = { ...process.env, PATH: `${bins.join(':')}:${process.env.PATH}`, FIXTURES: path.join(ROOT, 'test/fixtures') };
  try {
    spawnSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://git.example.com/wscegy/Kultura/kultura-mobile.git']);
    const result = spawnSync('node', [script,
      'https://dev.azure.com/wscegy/Kultura/_git/kultura-mobile/pullrequest/1845',
      '--dry-run', '--repo-dir', dir], { encoding: 'utf8', env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /origin does not match/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('review-pr: Azure resumes an interrupted post from the saved payload', () => {
  const script = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-azure-resume-repo-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-azure-resume-out-'));
  const forceOut = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-azure-force-out-'));
  const log = path.join(out, 'posted.ndjson');
  const gitLog = path.join(out, 'git.ndjson');
  const forceGitLog = path.join(forceOut, 'git.ndjson');
  const target = { host: 'azure', origin: 'dev.azure.com', org: 'wscegy', project: 'Kultura', owner: 'wscegy/Kultura', repo: 'kultura-mobile', number: 1845 };
  const head = '49793f1fec6cd58262e25752b79be791c68eb474';
  const savedRun = {
    schema: 'debate-review.run.v1',
    printOnly: false,
    force: true,
    postAttempt: 'forced-test',
    target,
    pr: { head },
    posted: {
      body: `<!-- debate-review head=${head} main=claude -->\nsummary`,
      comments: [{ path: 'lib/a.dart', line: 12, claim: 'one', body: '<!-- debate-review:F1 status=agreed -->\none' }],
    },
  };
  fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(savedRun));
  fs.writeFileSync(path.join(forceOut, 'run.json'), JSON.stringify(savedRun));
  const bins = [path.join(ROOT, 'test/fixtures/azure-git/bin'), path.join(ROOT, 'test/fixtures/azure/bin')];
  const env = {
    ...process.env,
    PATH: `${bins.join(':')}:${process.env.PATH}`,
    FIXTURES: path.join(ROOT, 'test/fixtures'),
    AZ_LOG: log,
    FAKE_GIT_LOG: gitLog,
    FAKE_GIT_MISSING_HEAD: '1',
  };
  try {
    const url = 'https://dev.azure.com/wscegy/Kultura/_git/kultura-mobile/pullrequest/1845';
    const forced = spawnSync('node', [script, url, '--repo-dir', repo, '--out-dir', forceOut, '--force'], {
      encoding: 'utf8', env: { ...env, FAKE_GIT_LOG: forceGitLog },
    });
    assert.equal(forced.status, 1);
    assert.doesNotMatch(forced.stderr, /resumed/);
    const forceGitCalls = fs.readFileSync(forceGitLog, 'utf8');
    assert.match(forceGitCalls, / fetch /);
    assert.doesNotMatch(forceGitCalls, /--config-env=.*(?:cat-file|worktree|diff|log)/);

    const args = [script, url, '--repo-dir', repo, '--out-dir', out];
    const failed = spawnSync('node', args, { encoding: 'utf8', env: { ...env, AZ_FAIL_POST: '1' } });
    assert.equal(failed.status, 1);
    assert.ok(JSON.parse(fs.readFileSync(path.join(out, 'run.json'))).posted);

    const result = spawnSync('node', args, { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /resumed 1 saved inline comment/);
    const posted = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(posted.length, 1);                       // existing inline reused; summary completed
    assert.equal(posted[0].status, 'closed');
    assert.doesNotMatch(fs.readFileSync(gitLog, 'utf8'), / fetch |worktree/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(out, 'run.json'))).postResult);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(forceOut, { recursive: true, force: true });
  }
});

test('review-pr: a corrupt Azure run log falls back to a normal review', () => {
  const script = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-azure-corrupt-repo-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-azure-corrupt-out-'));
  fs.writeFileSync(path.join(out, 'run.json'), '{');
  const bins = [path.join(ROOT, 'test/fixtures/azure-git/bin'), path.join(ROOT, 'test/fixtures/azure/bin')];
  const env = { ...process.env, PATH: `${bins.join(':')}:${process.env.PATH}`, FIXTURES: path.join(ROOT, 'test/fixtures') };
  try {
    const result = spawnSync('node', [script,
      'https://dev.azure.com/wscegy/Kultura/_git/kultura-mobile/pullrequest/1845',
      '--repo-dir', repo, '--out-dir', out], { encoding: 'utf8', env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /empty diff/);
    assert.doesNotMatch(result.stderr, /JSON|Unexpected end/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('review-pr: --local removes the snapshot if --out-dir cannot be created', () => {
  const script = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-local-src-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-local-tmp-'));
  const blocked = path.join(tmp, 'out-is-a-file');
  fs.writeFileSync(blocked, 'not-a-dir');
  try {
    spawnSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
    spawnSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'a'), 'a');
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-m', 'a']);
    const result = spawnSync('node', [script, '--local', '--repo-dir', dir, '--out-dir', blocked], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    });
    assert.equal(result.status, 1);
    const leftover = fs.readdirSync(tmp).filter((n) => n.startsWith('debate-review-local-'));
    assert.deepEqual(leftover, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validate: contract checks fail closed and fill missing verdicts', async () => {
  const { validateFindings, validateDebate, validateFinal } = await import('../skills/debate-review/scripts/lib/validate.mjs');
  const f = (id, extra = {}) => ({ id, file: 'a.py', line_start: 3, line_end: 4, severity: 'blocking', claim: 'x', confidence: 0.8, ...extra });
  const findings = validateFindings({ schema: 'debate-review.findings.v1', verdict: 'needs-attention', findings: [f('F1'), f('F2')] });
  assert.throws(() => validateFindings({ schema: 'debate-review.findings.v1', verdict: 'approve', findings: [f('F1', { severity: 'p1' })] }), /severity/);
  assert.throws(() => validateFindings({ schema: 'debate-review.findings.v1', verdict: 'approve', findings: [f('F1'), f('F1')] }), /duplicate/);

  const debate = validateDebate({ schema: 'debate-review.debate.v1', verdicts: [{ id: 'F1', verdict: 'refute', reason: 'r', evidence: 'e' }], new_findings: [f('D1')] }, findings);
  assert.deepEqual(debate.verdicts.map(v => `${v.id}:${v.verdict}`), ['F1:refute', 'F2:confirm']); // F2 filled as "no objection"
  const omitted = validateDebate({ schema: 'debate-review.debate.v1', verdicts: [{ id: 'F1', verdict: 'confirm' }, { id: 'F2', verdict: 'confirm' }] }, findings);
  assert.deepEqual(omitted.new_findings, []);
  assert.throws(() => validateDebate({ schema: 'debate-review.debate.v1', verdicts: [{ id: 'F1', verdict: 'confirm' }], new_findings: f('D1') }, findings), /new_findings must be an array/);
  assert.throws(() => validateDebate({ schema: 'debate-review.debate.v1', verdicts: [{ id: 'F1', verdict: 'confirm' }], new_findings: null }, findings), /new_findings must be an array/);
  assert.throws(() => validateDebate({ schema: 'debate-review.debate.v1', verdicts: [{ id: 'F9', verdict: 'confirm' }] }, findings), /unknown finding/);
  assert.throws(() => validateDebate({ schema: 'debate-review.debate.v1', verdicts: [{ id: 'F1', verdict: 'confirm' }, { id: 'F1', verdict: 'refute' }] }, findings), /more than one/);

  const ok = [f('F1', { status: 'withdrawn' }), f('F2', { status: 'agreed' }), f('D1', { status: 'agreed' })];
  validateFinal({ schema: 'debate-review.final.v1', findings: ok }, findings, debate);
  assert.throws(() => validateFinal({ schema: 'debate-review.final.v1', findings: ok.slice(0, 2) }, findings, debate), /dropped silently/);
  assert.throws(() => validateFinal({ schema: 'debate-review.final.v1', findings: [...ok, f('F7', { status: 'agreed' })] }, findings, debate), /from nowhere/);
  assert.throws(() => validateFinal({ schema: 'debate-review.final.v1', findings: [ok[0], ok[1], f('D1', { status: 'contested' })] }, findings, debate), /cannot be contested/);
});


test('render: levels, alerts, marker first, body counts', async () => {
  const { levelOf, renderInline, renderBody } = await import('../skills/debate-review/scripts/lib/render.mjs');
  const base = { file: 'a.py', line_start: 1, line_end: 2, claim: 'boom', evidence: 'e', recommendation: 'r', debate_note: 'n' };
  const p0 = { ...base, id: 'F1', status: 'agreed', severity: 'blocking', axis: 'security' };
  const p1 = { ...base, id: 'F2', status: 'contested', severity: 'blocking', axis: 'correctness' };
  const p2 = { ...base, id: 'D1', status: 'agreed', severity: 'non-blocking', axis: 'tests' };
  assert.deepEqual([levelOf(p0), levelOf(p1), levelOf(p2)], ['P0', 'P1', 'P2']);
  const c = renderInline(p1);
  assert.ok(c.startsWith('<!-- debate-review:F2 status=contested severity=blocking level=P1 -->\n> [!WARNING]\n> **P1, contested.'));
  assert.ok(renderInline(p0).includes('> [!CAUTION]') && renderInline(p2).includes('> [!NOTE]'));
  assert.ok(!/—/.test(c));
  const body = renderBody({ who: { main: { implementer: 'claude' }, debate: { implementer: 'codex' } }, finalDoc: { head: 'abcdef1234', summary: 'Ship.' }, posted: [p0, p1, p2], unanchored: [] });
  assert.ok(body.startsWith('<!-- debate-review head=abcdef1234 main=claude debate=codex agreed=2 contested=1 p0=1 p1=1 p2=1 -->'));
  assert.ok(body.includes('| P0 | 1 |') && body.includes('| contested | 1 |') && body.includes('on `abcdef1`'));
});

test('review-pr --check: reports each reviewer and fails when one cannot start', () => {
  const script = path.join(ROOT, 'skills/debate-review/scripts/review-pr.mjs');
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-check-skills-'));
  const relay = (name, body) => {
    const dir = path.join(skills, `${name}-delegate`, 'scripts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'relay.mjs'), `
if (process.argv.includes('--help')) { console.log('--read-only'); process.exit(0); }
const fs = await import('node:fs');
const out = process.argv[process.argv.indexOf('--out-dir') + 1];
${body}`);
  };
  relay('good', `fs.writeFileSync(out + '/result.json', JSON.stringify({ status: 'completed',
    finalMessage: '\`\`\`json\\n{"schema": "debate-review/check", "ok": true}\\n\`\`\`' }));`);
  relay('broken', `console.error('not logged in'); process.exit(1);`);
  const env = { ...process.env, DELEGATE_SKILLS_DIR: skills };
  const spawn = (args) => spawnSync('node', [script, '--check', ...args], { encoding: 'utf8', env });
  try {
    const ok = spawn(['--main', 'good', '--debate', 'good']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^main {4}good .* ok in \d+s$/m);
    assert.match(ok.stdout, /warning: main and debate are both good/);

    const failed = spawn(['--main', 'good', '--debate', 'broken']);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /^debate +broken .* FAIL: debate: relay exited 1 without writing result\.json$/m);

    assert.equal(spawn(['https://github.com/a/b/pull/1']).status, 2);
  } finally {
    fs.rmSync(skills, { recursive: true, force: true });
  }
});

test('dispatch: a completed relay with readOnlyViolation is rejected', () => {
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-rov-skills-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-rov-out-'));
  const dir = path.join(skills, 'probe-delegate', 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'relay.mjs'), `
if (process.argv.includes('--help')) { console.log('--read-only'); process.exit(0); }
const fs = await import('node:fs');
const outDir = process.argv[process.argv.indexOf('--out-dir') + 1];
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outDir + '/result.json', JSON.stringify({
  status: 'completed',
  readOnlyViolation: true,
  finalMessage: 'should not be used',
}));
`);
  const saved = process.env.DELEGATE_SKILLS_DIR;
  process.env.DELEGATE_SKILLS_DIR = skills;
  try {
    assert.throws(
      () => dispatch({ role: 'main', who: { implementer: 'probe' }, brief: 'x', cwd: process.cwd(), outDir: out, timeout: '1m' }),
      /read-only violation.*see /,
    );
    const err = (() => {
      try {
        dispatch({ role: 'main', who: { implementer: 'probe' }, brief: 'x', cwd: process.cwd(), outDir: out, timeout: '1m' });
      } catch (error) {
        return error.message;
      }
    })();
    assert.match(err, new RegExp(out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    saved === undefined ? delete process.env.DELEGATE_SKILLS_DIR : (process.env.DELEGATE_SKILLS_DIR = saved);
    fs.rmSync(skills, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('gitlab: context comments send old_line; a retry does not duplicate discussions', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-glab-store-'));
  const log = path.join(store, 'posted.ndjson');
  const saved = { PATH: process.env.PATH, GLAB_STORE: process.env.GLAB_STORE, GLAB_LOG: process.env.GLAB_LOG, GLAB_FAIL_AFTER: process.env.GLAB_FAIL_AFTER };
  process.env.PATH = `${path.join(ROOT, 'test/fixtures/gitlab-forge/bin')}:${process.env.PATH}`;
  process.env.GLAB_STORE = store;
  process.env.GLAB_LOG = log;
  const t = { host: 'gitlab', origin: 'gitlab.example.com', owner: 'grp', repo: 'proj', number: 45 };
  const pr = {
    head: 'bbbb2222',
    baseSha: 'basebase',
    startSha: 'startstart',
    url: 'https://gitlab.example.com/grp/proj/-/merge_requests/45',
  };
  const comments = [
    { path: 'lib/x.rb', line: 7, old_line: 7, claim: 'naming', body: '<!-- debate-review:F1 -->\nnaming' },
    { path: 'lib/x.rb', line: 12, claim: 'added', body: '<!-- debate-review:F2 -->\nadded' },
  ];
  const summary = '<!-- debate-review head=bbbb2222 main=claude debate=codex agreed=2 contested=0 p0=0 p1=1 p2=1 -->\nsummary';
  try {
    process.env.GLAB_FAIL_AFTER = '1';
    assert.throws(() => postReview(t, pr, summary, comments), /requested POST failure/);
    delete process.env.GLAB_FAIL_AFTER;

    const first = postReview(t, pr, summary, comments);
    assert.equal(first.discussionIds.length, 2);
    assert.equal(first.discussionIds[0], 'd1'); // reused from the partial post
    const posted = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(posted.length, 3); // 1 from the failed attempt + 1 remaining discussion + summary
    assert.equal(posted[0].position.old_line, 7);
    assert.equal(posted[0].position.new_line, 7);
    assert.equal(posted[1].position.old_line, undefined);
    assert.equal(posted[1].position.new_line, 12);
    assert.match(posted[0].body, /debate-review finding=[0-9a-f]{16} head=bbbb2222/);
    assert.equal(posted[2].body, summary);

    const logAfter = fs.readFileSync(log, 'utf8');
    const resumed = postReview(t, pr, summary, comments);
    assert.deepEqual(resumed.discussionIds, first.discussionIds);
    assert.equal(resumed.noteId, first.noteId);
    assert.equal(fs.readFileSync(log, 'utf8'), logAfter); // no new POSTs
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('makeWorktree: post-checkout hooks in the clone do not run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-wt-src-'));
  const sentinel = path.join(dir, 'hook-ran');
  let worktree;
  let bare;
  try {
    spawnSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
    spawnSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-m', 'a']);
    const hook = path.join(dir, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${sentinel}"\n`);
    fs.chmodSync(hook, 0o755);

    bare = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-wt-bare-'));
    fs.rmSync(bare, { recursive: true, force: true });
    spawnSync('git', ['clone', '--bare', dir, bare], { encoding: 'utf8' });
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', bare]);
    spawnSync('git', ['-C', dir, 'fetch', 'origin'], { encoding: 'utf8' });
    const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

    const control = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-wt-control-'));
    fs.rmSync(control, { recursive: true, force: true });
    spawnSync('git', ['-C', dir, 'worktree', 'add', '--detach', '--quiet', control, head], { encoding: 'utf8' });
    assert.equal(fs.existsSync(sentinel), true, 'control: git worktree add runs post-checkout');
    fs.rmSync(sentinel, { force: true });
    spawnSync('git', ['-C', dir, 'worktree', 'remove', '--force', control], { encoding: 'utf8' });

    worktree = makeWorktree(dir, { head, fetchRef: 'main' }, 'main', { args: [], env: process.env });
    assert.equal(fs.existsSync(sentinel), false, 'makeWorktree must isolate hooks');
    assert.equal(fs.existsSync(path.join(worktree, 'a.txt')), true);
  } finally {
    if (worktree) spawnSync('git', ['-C', dir, 'worktree', 'remove', '--force', worktree], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    if (bare) fs.rmSync(bare, { recursive: true, force: true });
  }
});

