// What gets posted: the round body and each inline comment, as Markdown both forges render.
// Severity on the PR is shown as a P-level inside a forge alert (CAUTION / WARNING / NOTE), so the
// reader sees a colour before a word. The JSON contract stays blocking / non-blocking; the level is
// computed here.

/** P0: blocking on the security axis. P1: any other blocking. P2: non-blocking. */
export function levelOf(finding) {
  if (finding.severity === 'blocking') return finding.axis === 'security' ? 'P0' : 'P1';
  return 'P2';
}

const ALERT = { P0: 'CAUTION', P1: 'WARNING', P2: 'NOTE' };

function statusPhrase(f) {
  if (f.status === 'contested') return 'contested. The second reviewer disagreed; the main reviewer holds it, reasons below.';
  return 'agreed by both reviewers.';
}

/** One inline comment. The HTML marker stays first so babysit-pr and the re-run check find it. */
export function renderInline(f) {
  const level = levelOf(f);
  const quote = (text) => text.split('\n').map(l => `> ${l}`.trimEnd()).join('\n');
  let body = `<!-- debate-review:${f.id} status=${f.status} severity=${f.severity} level=${level} -->\n`;
  body += `> [!${ALERT[level]}]\n`;
  body += quote(`**${level}, ${statusPhrase(f)}** ${f.claim}`) + '\n\n';
  if (f.evidence) body += `${f.evidence}\n\n`;
  if (f.recommendation) body += `Suggested: ${f.recommendation}\n\n`;
  if (f.debate_note) body += `_${f.debate_note}_\n`;
  return body;
}

/** The one review body per head sha: marker, a count per level, who reviewed, the summary. */
export function renderBody({ who, finalDoc, posted, unanchored }) {
  const counts = { P0: 0, P1: 0, P2: 0 };
  let contested = 0;
  for (const f of posted) { counts[levelOf(f)] += 1; if (f.status === 'contested') contested += 1; }
  const agreed = posted.length - contested;

  let body = `<!-- debate-review head=${finalDoc.head} main=${who.main.implementer} debate=${who.debate.implementer} agreed=${agreed} contested=${contested} p0=${counts.P0} p1=${counts.P1} p2=${counts.P2} -->\n`;
  body += `| Level | Count |\n| --- | ---: |\n`;
  body += `| P0 | ${counts.P0} |\n| P1 | ${counts.P1} |\n| P2 | ${counts.P2} |\n| contested | ${contested} |\n\n`;
  body += `**debate-review** on \`${finalDoc.head.slice(0, 7)}\`, main \`${who.main.implementer}\`, second \`${who.debate.implementer}\`.\n\n`;
  body += `${finalDoc.summary || ''}\n`;

  if (unanchored.length > 0) {
    body += `\nFindings outside the diff (could not be anchored inline):\n`;
    for (const f of unanchored) {
      body += `\n- **${levelOf(f)}, ${f.status}.** \`${f.file}:${f.line_start}\` ${f.claim}`;
    }
    body += '\n';
  }
  return body;
}
