// Everything that talks to GitHub (gh), GitLab (glab) or Azure DevOps (az): identify the PR, read it, post the review.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run, text, json } from './shell.mjs';

// Azure DevOps: the token audience `az rest` needs, and the API version every call is pinned to.
const AZURE_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const AZURE_API = '7.1';

// ---------- identify the target ----------

/** Turn a PR URL or a bare number (+ git origin) into { host, origin, owner, repo, number }. */
export function parseTarget(target, originUrl) {
  // GitLab first: `/-/merge_requests/` is unambiguous. GitHub Enterprise hosts can be named anything.
  const gitlab = target.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (gitlab) {
    const segments = gitlab[2].split('/');
    return { host: 'gitlab', origin: gitlab[1], owner: segments.slice(0, -1).join('/'), repo: segments.at(-1), number: Number(gitlab[3]) };
  }

  // https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>  (project omitted when it equals the repo)
  const azure = target.match(/^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/?#]+)\/(?:([^/?#]+)\/)?_git\/([^/?#]+)\/pullrequest\/(\d+)/i);
  if (azure) {
    const repo = decodeURIComponent(azure[3]);
    return azureTarget(decodeURIComponent(azure[1]), azure[2] ? decodeURIComponent(azure[2]) : repo, repo, Number(azure[4]));
  }

  // https://<org>.visualstudio.com/<project>/_git/<repo>/pullrequest/<id>  (legacy host, same API)
  const vsts = target.match(/^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:(?:[^/?#]+\/)?([^/?#]+)\/)?_git\/([^/?#]+)\/pullrequest\/(\d+)/i);
  if (vsts) {
    const repo = decodeURIComponent(vsts[3]);
    return azureTarget(vsts[1], legacyAzureProject(vsts[2], repo), repo, Number(vsts[4]));
  }

  const github = target.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/pull\/(\d+)/);
  if (github) {
    return { host: 'github', origin: github[1].toLowerCase(), owner: github[2], repo: github[3], number: Number(github[4]) };
  }

  if (/^\d+$/.test(target)) {
    if (!originUrl) throw new Error('a bare PR number needs a git remote to resolve against');
    const origin = parseOrigin(originUrl);
    if (!origin) throw new Error(`cannot parse git origin: ${originUrl}`);
    return { ...origin, number: Number(target) };
  }

  throw new Error(`unrecognised target: ${target}`);
}

/** Azure DevOps addresses a repo by org + project; `owner` keeps the rest of the script forge-neutral. */
function azureTarget(org, project, repo, number) {
  const t = { host: 'azure', origin: 'dev.azure.com', org, project, owner: `${org}/${project}`, repo };
  return number === undefined ? t : { ...t, number };
}

function legacyAzureProject(segment, repo) {
  const project = segment ? decodeURIComponent(segment) : repo;
  return project.toLowerCase() === 'defaultcollection' ? repo : project;
}

/** Parse a git remote URL (https or ssh) into { host, origin, owner, repo }. */
export function parseOrigin(url) {
  const m = url.match(/^(?:https?:\/\/|ssh:\/\/)(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/)
    || url.match(/^(?:[^@/]+@)?([^/:]+)[/:](.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const origin = m[1].toLowerCase();
  const segments = m[2].split('/');

  const azure = azureOrigin(origin, segments);
  if (azure) return azure;

  return {
    host: detectHost(origin),
    origin,
    owner: segments.slice(0, -1).join('/'),
    repo: segments.at(-1),
  };
}

/** The three Azure DevOps remote shapes: ssh v3, dev.azure.com https, legacy visualstudio.com https. */
function azureOrigin(origin, segments) {
  if (origin === 'ssh.dev.azure.com' || origin === 'vs-ssh.visualstudio.com') {
    // v3/<org>/<project>/<repo>
    if (segments[0] !== 'v3' || segments.length < 4) return null;
    return azureTarget(...segments.slice(1, 4).map(decodeURIComponent));
  }

  if (origin === 'dev.azure.com') {
    // <org>/<project>/_git/<repo>  or  <org>/_git/<repo>
    const git = segments.indexOf('_git');
    if (git < 1 || git !== segments.length - 2) return null;
    const repo = decodeURIComponent(segments[git + 1]);
    return azureTarget(decodeURIComponent(segments[0]), git === 2 ? decodeURIComponent(segments[1]) : repo, repo);
  }

  if (origin.endsWith('.visualstudio.com')) {
    const git = segments.indexOf('_git');
    if (git < 0 || git !== segments.length - 2) return null;
    const repo = decodeURIComponent(segments[git + 1]);
    return azureTarget(origin.split('.')[0], legacyAzureProject(segments[git - 1], repo), repo);
  }

  return null;
}

const hostCache = new Map();

/**
 * github or gitlab for an arbitrary origin. A GitHub Enterprise host can be named
 * anything, so ask gh whether it is logged in there rather than matching on the name;
 * that is also the check that decides whether the gh calls below can work at all.
 * No gh, or not logged in to that host, means gitlab.
 */
function detectHost(origin) {
  if (origin === 'github.com') return 'github';
  if (!hostCache.has(origin)) {
    let ok = false;
    try {
      ok = run('gh', ['auth', 'status', '--hostname', origin], { allowFail: true }).status === 0;
    } catch {
      ok = false; // gh not installed
    }
    hostCache.set(origin, ok ? 'github' : 'gitlab');
  }
  return hostCache.get(origin);
}

export function projectPath(t) {
  return `${t.owner}/${t.repo}`;
}

/** The https URL to clone this repo from. */
export function cloneUrl(t) {
  if (t.host === 'azure') return `${azureProjectUrl(t)}/_git/${encodeURIComponent(t.repo)}`;
  return `https://${t.origin}/${projectPath(t)}.git`;
}

/** Git options that reuse `az login` without putting the bearer token in argv or the remote URL. */
export function gitAuth(t) {
  if (t.host !== 'azure') return { args: [], env: process.env };
  const token = text('az', ['account', 'get-access-token', '--resource', AZURE_RESOURCE,
    '--query', 'accessToken', '--output', 'tsv']);
  return {
    args: [
      '--config-env=http.https://dev.azure.com/.extraheader=DEBATE_REVIEW_AZURE_AUTH',
      `--config-env=http.https://${t.org}.visualstudio.com/.extraheader=DEBATE_REVIEW_AZURE_AUTH`,
    ],
    env: { ...process.env, DEBATE_REVIEW_AZURE_AUTH: `AUTHORIZATION: bearer ${token}` },
  };
}

function glabProject(t) {
  return encodeURIComponent(projectPath(t));
}

function glabEnv(t) {
  return { ...process.env, GITLAB_HOST: t.origin };
}

// ---------- azure devops REST over `az rest` ----------

function azureProjectUrl(t) {
  return `https://dev.azure.com/${encodeURIComponent(t.org)}/${encodeURIComponent(t.project)}`;
}

function azureRepoApi(t, suffix) {
  return `${azureProjectUrl(t)}/_apis/git/repositories/${encodeURIComponent(t.repo)}${suffix}`;
}

/**
 * One `az rest` call. The body goes through a temp file so no payload has to survive shell quoting
 * or an argv length limit.
 */
function azureRest(url, { method = 'GET', body } = {}) {
  const separator = url.includes('?') ? '&' : '?';
  const args = ['rest', '--method', method, '--url', `${url}${separator}api-version=${AZURE_API}`,
    '--resource', AZURE_RESOURCE, '--output', 'json'];

  let file;
  try {
    if (body !== undefined) {
      file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'debate-review-az-')), 'body.json');
      fs.writeFileSync(file, JSON.stringify(body));
      args.push('--headers', 'Content-Type=application/json', '--body', `@${file}`);
    }
    return json('az', args);
  } finally {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

const shortRef = (ref) => String(ref || '').replace(/^refs\/heads\//, '');

// GH_HOST points gh at the right instance; a no-op when the origin is github.com.
function ghEnv(t) {
  return { ...process.env, GH_HOST: t.origin };
}

// ---------- read the PR ----------

/** Fetch what we need about the PR/MR: title, body, head/base shas, branch names, fetch ref. */
export function fetchPR(t) {
  if (t.host === 'github') {
    const env = ghEnv(t);
    const pr = json('gh', ['pr', 'view', String(t.number), '--repo', projectPath(t),
      '--json', 'title,body,url,headRefOid,headRefName,baseRefName'], { env });
    const baseSha = text('gh', ['api', `repos/${projectPath(t)}/pulls/${t.number}`, '-q', '.base.sha'], { env });
    return {
      title: pr.title,
      body: pr.body || '',
      url: pr.url,
      head: pr.headRefOid,
      headRef: pr.headRefName,
      baseRef: pr.baseRefName,
      baseSha,
      fetchRef: `pull/${t.number}/head`,
    };
  }

  if (t.host === 'azure') {
    const pr = azureRest(azureRepoApi(t, `/pullRequests/${t.number}`));
    const head = pr.lastMergeSourceCommit?.commitId;
    const baseSha = pr.lastMergeTargetCommit?.commitId;
    if (!head || !baseSha) throw new Error(`PR ${t.number} has no merge commits; Azure DevOps has not computed its merge yet`);
    const iterations = azureRest(azureRepoApi(t, `/pullRequests/${t.number}/iterations?includeCommits=true`));
    const iteration = (iterations.value || []).filter(entry => entry.sourceRefCommit?.commitId === head).at(-1);
    return {
      title: pr.title,
      body: pr.description || '',
      url: `${pr.repository.webUrl}/pullrequest/${t.number}`,
      head,
      headRef: shortRef(pr.sourceRefName),
      baseRef: shortRef(pr.targetRefName),
      baseSha,
      iterationId: iteration?.id,
      // The merge ref carries the head as a parent and exists even for a fork PR; the source branch
      // is the fallback for a PR whose merge could not be computed (conflicts).
      fetchRef: `refs/pull/${t.number}/merge`,
      fetchRefAlt: shortRef(pr.sourceRefName),
      fetchUrlAlt: pr.forkSource?.repository?.remoteUrl,
    };
  }

  const mr = json('glab', ['api', `projects/${glabProject(t)}/merge_requests/${t.number}`], { env: glabEnv(t) });
  return {
    title: mr.title,
    body: mr.description || '',
    url: mr.web_url,
    head: mr.diff_refs.head_sha,
    headRef: mr.source_branch,
    baseRef: mr.target_branch,
    baseSha: mr.diff_refs.base_sha,
    startSha: mr.diff_refs.start_sha,
    fetchRef: `merge-requests/${t.number}/head`,
  };
}

/** True if a debate-review for this head sha is already on the PR. */
export function alreadyReviewed(t, pr) {
  const marker = `<!-- debate-review head=${pr.head}`;
  if (t.host === 'github') {
    const bodies = text('gh', ['api', `repos/${projectPath(t)}/pulls/${t.number}/reviews`, '--paginate', '-q', '.[].body'], { env: ghEnv(t) });
    return bodies.includes(marker);
  }
  if (t.host === 'azure') {
    const threads = azureRest(azureRepoApi(t, `/pullRequests/${t.number}/threads`));
    return JSON.stringify(threads).includes(marker);
  }
  const notes = text('glab', ['api', `projects/${glabProject(t)}/merge_requests/${t.number}/notes?per_page=100`, '--paginate'], { env: glabEnv(t) });
  return notes.includes(marker);
}

/** Collect up to two referenced issues (#123) as the Spec source. */
export function fetchSpec(t, pr, commitsText) {
  const haystack = `${pr.title}\n${pr.body}\n${commitsText}`;
  const numbers = [...new Set([...haystack.matchAll(/(?:^|[^\w/])#(\d+)\b/g)].map(m => m[1]))].slice(0, 2);

  const parts = [];
  for (const n of numbers) {
    try {
      if (t.host === 'github') {
        const issue = json('gh', ['issue', 'view', n, '--repo', projectPath(t), '--json', 'title,body,url'], { env: ghEnv(t) });
        parts.push(`Issue #${n}: ${issue.title}\n${issue.url}\n${issue.body || ''}`);
      } else if (t.host === 'azure') {
        // On Azure DevOps "#123" is a work item, and its description is HTML.
        const item = azureRest(`${azureProjectUrl(t)}/_apis/wit/workitems/${n}`);
        const fields = item.fields || {};
        const url = item._links?.html?.href || `${azureProjectUrl(t)}/_workitems/edit/${n}`;
        const body = stripHtml(fields['System.Description'] || fields['Microsoft.VSTS.TCM.ReproSteps']);
        if (body) parts.push(`Work item #${n}: ${fields['System.Title'] || ''}\n${url}\n${body}`);
      } else {
        const issue = json('glab', ['api', `projects/${glabProject(t)}/issues/${n}`], { env: glabEnv(t) });
        parts.push(`Issue #${n}: ${issue.title}\n${issue.web_url}\n${issue.description || ''}`);
      }
    } catch {
      // "#12" was not an issue (PR number, plain text). skip it
    }
  }
  if (parts.length === 0) return 'none found, skip the Spec axis';
  return parts.join('\n\n---\n\n').slice(0, 8000);
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- post the review ----------

/**
 * Post one review with inline comments. `comments` items: { path, line, start_line?, body }.
 * Event is always COMMENT. never approve/request-changes on the author's behalf.
 */
export function postReview(t, pr, body, comments) {
  if (t.host === 'github') return postGithub(t, pr, body, comments);
  if (t.host === 'azure') return postAzure(t, pr, body, comments);
  return postGitlab(t, pr, body, comments);
}

function postGithub(t, pr, body, comments) {
  const payload = {
    commit_id: pr.head,
    event: 'COMMENT',
    body,
    comments: comments.map(c => ({
      path: c.path,
      line: c.line,
      side: 'RIGHT',
      body: c.body,
      ...(c.start_line ? { start_line: c.start_line, start_side: 'RIGHT' } : {}),
    })),
  };
  const review = json('gh', ['api', '--method', 'POST', `repos/${projectPath(t)}/pulls/${t.number}/reviews`, '--input', '-'],
    { input: JSON.stringify(payload), env: ghEnv(t) });
  return { reviewId: review.id, url: review.html_url };
}

function postGitlab(t, pr, body, comments) {
  const base = `projects/${glabProject(t)}/merge_requests/${t.number}`;
  const env = glabEnv(t);
  const discussionIds = [];

  for (const c of comments) {
    const payload = {
      body: c.body,
      position: {
        position_type: 'text',
        base_sha: pr.baseSha,
        start_sha: pr.startSha,
        head_sha: pr.head,
        new_path: c.path,
        old_path: c.path,
        new_line: c.line,
      },
    };
    const discussion = json('glab', ['api', '--method', 'POST', `${base}/discussions`, '--input', '-'],
      { input: JSON.stringify(payload), env });
    discussionIds.push(discussion.id);
  }

  const note = json('glab', ['api', '--method', 'POST', `${base}/notes`, '--input', '-'],
    { input: JSON.stringify({ body }), env });
  return { noteId: note.id, discussionIds, url: pr.url };
}

/**
 * Azure DevOps has no single "review" object: a review is N inline threads plus one summary thread.
 * Threads are posted first so a failure cannot leave a summary claiming comments that are not there.
 */
function postAzure(t, pr, body, comments) {
  const url = azureRepoApi(t, `/pullRequests/${t.number}/threads`);
  const existingThreads = !pr.force ? azureRest(url).value || [] : [];
  const changes = comments.length && pr.iterationId ? azureIterationChanges(t, pr) : [];
  const changeIds = new Map(changes.map(change => [change.item?.path, change.changeTrackingId]));
  const threadIds = [];

  for (const c of comments) {
    if (!c.claim) throw new Error('Azure inline comment is missing its finding claim');
    const filePath = c.path.startsWith('/') ? c.path : `/${c.path}`;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([filePath, c.start_line || c.line, c.line, c.claim]))
      .digest('hex').slice(0, 16);
    const marker = `<!-- debate-review finding=${fingerprint} head=${pr.head}${pr.postAttempt ? ` attempt=${pr.postAttempt}` : ''} -->`;
    const existing = existingThreads.find(thread =>
      thread.comments?.some(comment => String(comment.content).includes(marker)));
    if (existing) {
      threadIds.push(existing.id);
      continue;
    }

    const changeTrackingId = changeIds.get(filePath);
    const thread = azureRest(url, {
      method: 'POST',
      body: {
        comments: [{ parentCommentId: 0, content: `${marker}\n${c.body}`, commentType: 'text' }],
        status: 'active',
        threadContext: {
          filePath,
          rightFileStart: { line: c.start_line || c.line, offset: 1 },
          rightFileEnd: { line: c.line, offset: 1 },
        },
        ...(changeTrackingId === undefined ? {} : {
          pullRequestThreadContext: {
            changeTrackingId,
            iterationContext: {
              firstComparingIteration: pr.iterationId,
              secondComparingIteration: pr.iterationId,
            },
          },
        }),
      },
    });
    threadIds.push(thread.id);
  }

  const headMarker = `<!-- debate-review head=${pr.head}`;
  const summaryMarker = pr.postAttempt ? `${headMarker} attempt=${pr.postAttempt}` : `${headMarker} main=`;
  const existingSummary = existingThreads.find(thread =>
    thread.comments?.some(comment => String(comment.content).includes(summaryMarker)));
  if (existingSummary) return { summaryThreadId: existingSummary.id, threadIds, url: pr.url };

  const summaryBody = pr.postAttempt
    ? body.replace(headMarker, `${headMarker} attempt=${pr.postAttempt}`)
    : body;
  const summary = azureRest(url, {
    method: 'POST',
    body: { comments: [{ parentCommentId: 0, content: summaryBody, commentType: 'text' }], status: 'closed' },
  });
  return { summaryThreadId: summary.id, threadIds, url: pr.url };
}

function azureIterationChanges(t, pr) {
  const entries = [];
  let skip = 0;
  do {
    const page = azureRest(azureRepoApi(t,
      `/pullRequests/${t.number}/iterations/${pr.iterationId}/changes?$top=2000&$skip=${skip}`));
    entries.push(...(page.changeEntries || []));
    skip = page.nextSkip || 0;
  } while (skip > 0);
  return entries;
}
