// Contract checks for the three documents. The pipeline fails closed on any violation: a malformed
// document is never posted as if it were a review.

const SEVERITIES = new Set(['blocking', 'non-blocking']);
const AXES = new Set(['correctness', 'security', 'spec', 'standards', 'tests', 'docs']);
const VERDICTS = new Set(['confirm', 'refute', 'downgrade']);
const STATUSES = new Set(['agreed', 'contested', 'withdrawn']);

function problem(role, message) {
  return new Error(`${role}: ${message}`);
}

function isInt(n) {
  return Number.isInteger(n);
}

/** One finding object, shared by findings.v1 (F*), debate.v1 new_findings (D*), and final.v1. */
function checkFinding(role, f, index, { idPrefix, needStatus }) {
  const where = `finding[${index}]${f && f.id ? ` (${f.id})` : ''}`;
  if (!f || typeof f !== 'object') throw problem(role, `${where} is not an object`);
  if (typeof f.id !== 'string' || !new RegExp(`^${idPrefix}\\d+$`).test(f.id)) {
    throw problem(role, `${where} id must look like ${idPrefix}<n>`);
  }
  if (typeof f.file !== 'string' || f.file.length === 0) throw problem(role, `${where} has no file`);
  if (!isInt(f.line_start) || !isInt(f.line_end) || f.line_start < 1 || f.line_end < f.line_start) {
    throw problem(role, `${where} has bad line_start/line_end`);
  }
  if (!SEVERITIES.has(f.severity)) throw problem(role, `${where} severity must be blocking|non-blocking`);
  if (typeof f.claim !== 'string' || f.claim.length === 0) throw problem(role, `${where} has no claim`);
  if (needStatus) {
    if (!STATUSES.has(f.status)) throw problem(role, `${where} status must be agreed|contested|withdrawn`);
  } else {
    if (f.axis !== undefined && !AXES.has(f.axis)) throw problem(role, `${where} axis is not one of ${[...AXES].join('|')}`);
    if (f.confidence !== undefined && !(typeof f.confidence === 'number' && f.confidence >= 0 && f.confidence <= 1)) {
      throw problem(role, `${where} confidence must be a number in 0..1`);
    }
  }
}

function checkUniqueIds(role, list, label) {
  const seen = new Set();
  for (const item of list) {
    if (seen.has(item.id)) throw problem(role, `duplicate ${label} id ${item.id}`);
    seen.add(item.id);
  }
}

/** debate-review.findings.v1 */
export function validateFindings(doc, role = 'main') {
  if (!doc || doc.schema !== 'debate-review.findings.v1') throw problem(role, 'expected schema debate-review.findings.v1');
  if (!['approve', 'needs-attention'].includes(doc.verdict)) throw problem(role, 'verdict must be approve|needs-attention');
  if (!Array.isArray(doc.findings)) throw problem(role, 'findings must be an array');
  doc.findings.forEach((f, i) => checkFinding(role, f, i, { idPrefix: 'F', needStatus: false }));
  checkUniqueIds(role, doc.findings, 'finding');
  return doc;
}

/**
 * debate-review.debate.v1. checked against the findings it answers.
 * Missing verdicts are filled as confirm ("no objection"), as schema.md promises; duplicates are errors.
 */
export function validateDebate(doc, findings, role = 'debate') {
  if (!doc || doc.schema !== 'debate-review.debate.v1') throw problem(role, 'expected schema debate-review.debate.v1');
  if (!Array.isArray(doc.verdicts)) throw problem(role, 'verdicts must be an array');
  doc.new_findings = Array.isArray(doc.new_findings) ? doc.new_findings : [];

  const known = new Set(findings.findings.map(f => f.id));
  const answered = new Set();
  doc.verdicts.forEach((v, i) => {
    if (!v || typeof v.id !== 'string') throw problem(role, `verdict[${i}] has no id`);
    if (!known.has(v.id)) throw problem(role, `verdict[${i}] answers unknown finding ${v.id}`);
    if (answered.has(v.id)) throw problem(role, `finding ${v.id} has more than one verdict`);
    if (!VERDICTS.has(v.verdict)) throw problem(role, `verdict for ${v.id} must be confirm|refute|downgrade`);
    answered.add(v.id);
  });
  for (const id of known) {
    if (!answered.has(id)) doc.verdicts.push({ id, verdict: 'confirm', reason: 'no objection', evidence: '' });
  }

  doc.new_findings.forEach((f, i) => checkFinding(role, f, i, { idPrefix: 'D', needStatus: false }));
  checkUniqueIds(role, doc.new_findings, 'new finding');
  return doc;
}

/** debate-review.final.v1. every F* and D* must come back with a status; nothing may appear from nowhere. */
export function validateFinal(doc, findings, debate, role = 'final') {
  if (!doc || doc.schema !== 'debate-review.final.v1') throw problem(role, 'expected schema debate-review.final.v1');
  if (!Array.isArray(doc.findings)) throw problem(role, 'findings must be an array');

  doc.findings.forEach((f, i) => checkFinding(role, f, i, { idPrefix: '[FD]', needStatus: true }));
  checkUniqueIds(role, doc.findings, 'final finding');

  const expected = new Set([...findings.findings.map(f => f.id), ...debate.new_findings.map(f => f.id)]);
  const returned = new Set(doc.findings.map(f => f.id));
  for (const id of expected) if (!returned.has(id)) throw problem(role, `finding ${id} was dropped silently`);
  for (const id of returned) if (!expected.has(id)) throw problem(role, `finding ${id} appeared from nowhere`);

  for (const f of doc.findings) {
    if (f.id.startsWith('D') && f.status === 'contested') {
      throw problem(role, `${f.id}: a D* finding cannot be contested, only agreed or withdrawn`);
    }
  }
  return doc;
}
