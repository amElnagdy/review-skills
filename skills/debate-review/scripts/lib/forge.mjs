// Everything that talks to GitHub (gh) or GitLab (glab): identify the PR, read it, post the review.
import { text, json } from './shell.mjs';

// ---------- identify the target ----------

/** Turn a PR URL or a bare number (+ git origin) into { host, origin, owner, repo, number }. */
export function parseTarget(target, originUrl) {
  const github = target.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/pull\/(\d+)/);
  if (github) {
    return { host: 'github', origin: 'github.com', owner: github[1], repo: github[2], number: Number(github[3]) };
  }

  const gitlab = target.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (gitlab) {
    const segments = gitlab[2].split('/');
    return { host: 'gitlab', origin: gitlab[1], owner: segments.slice(0, -1).join('/'), repo: segments.at(-1), number: Number(gitlab[3]) };
  }

  if (/^\d+$/.test(target)) {
    if (!originUrl) throw new Error('a bare PR number needs a git remote to resolve against');
    const origin = parseOrigin(originUrl);
    if (!origin) throw new Error(`cannot parse git origin: ${originUrl}`);
    return { ...origin, number: Number(target) };
  }

  throw new Error(`unrecognised target: ${target}`);
}

/** Parse a git remote URL (https or ssh) into { host, origin, owner, repo }. */
export function parseOrigin(url) {
  const m = url.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const origin = m[1].toLowerCase();
  const segments = m[2].split('/');
  return {
    host: origin === 'github.com' ? 'github' : 'gitlab',
    origin,
    owner: segments.slice(0, -1).join('/'),
    repo: segments.at(-1),
  };
}

export function projectPath(t) {
  return `${t.owner}/${t.repo}`;
}

function glabProject(t) {
  return encodeURIComponent(projectPath(t));
}

function glabEnv(t) {
  return { ...process.env, GITLAB_HOST: t.origin };
}

// ---------- read the PR ----------

/** Fetch what we need about the PR/MR: title, body, head/base shas, branch names, fetch ref. */
export function fetchPR(t) {
  if (t.host === 'github') {
    const pr = json('gh', ['pr', 'view', String(t.number), '--repo', projectPath(t),
      '--json', 'title,body,url,headRefOid,headRefName,baseRefName']);
    const baseSha = text('gh', ['api', `repos/${projectPath(t)}/pulls/${t.number}`, '-q', '.base.sha']);
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
    const bodies = text('gh', ['api', `repos/${projectPath(t)}/pulls/${t.number}/reviews`, '--paginate', '-q', '.[].body']);
    return bodies.includes(marker);
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
        const issue = json('gh', ['issue', 'view', n, '--repo', projectPath(t), '--json', 'title,body,url']);
        parts.push(`Issue #${n}: ${issue.title}\n${issue.url}\n${issue.body || ''}`);
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

// ---------- post the review ----------

/**
 * Post one review with inline comments. `comments` items: { path, line, start_line?, body }.
 * Event is always COMMENT. never approve/request-changes on the author's behalf.
 */
export function postReview(t, pr, body, comments) {
  if (t.host === 'github') return postGithub(t, pr, body, comments);
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
    { input: JSON.stringify(payload) });
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
