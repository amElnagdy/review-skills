// Map the PR diff so findings can be anchored to lines the forge will accept an inline comment on.

/**
 * Parse a unified diff. Returns Map<path, Set<lineNumber>> of new-side lines that appear in the
 * diff (added lines and context lines). Removed lines and deleted files are not commentable.
 */
export function diffLineMap(diffText) {
  const map = new Map();
  let file = null;
  let line = 0;

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) { file = null; continue; }
    if (raw.startsWith('--- ')) continue;

    if (raw.startsWith('+++ ')) {
      const name = raw.slice(4).replace(/^b\//, '');
      file = name === '/dev/null' ? null : name;
      if (file) map.set(file, new Set());
      continue;
    }

    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }

    if (!file) continue;
    if (raw.startsWith('-')) continue;       // removed line: no new-side number
    if (raw.startsWith('\\')) continue;      // "\ No newline at end of file"

    // '+' (added) or ' ' (context): both have a new-side line number
    map.get(file).add(line);
    line += 1;
  }
  return map;
}

/**
 * Pick a commentable anchor for a finding: { path, line, start_line?, snapped }.
 * Returns null when the file is not in the diff at all.
 */
export function anchor(map, finding) {
  const lines = map.get(finding.file);
  if (!lines || lines.size === 0) return null;

  const nearest = (n) => [...lines].reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best));
  const wantedEnd = finding.line_end || finding.line_start;
  const end = lines.has(wantedEnd) ? wantedEnd : nearest(wantedEnd);

  let start = lines.has(finding.line_start) ? finding.line_start : undefined;
  if (start !== undefined && start >= end) start = undefined;

  // A multi-line comment needs every line in between to be in the diff too.
  if (start !== undefined) {
    for (let i = start; i <= end; i++) {
      if (!lines.has(i)) { start = undefined; break; }
    }
  }

  return { path: finding.file, line: end, start_line: start, snapped: end !== wantedEnd };
}
