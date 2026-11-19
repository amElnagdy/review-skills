// Map the PR diff so findings can be anchored to lines the forge will accept an inline comment on.

/**
 * Parse a unified diff. Returns Map<path, Map<newLine, oldLine|null>> of new-side lines that appear
 * in the diff (added lines and context lines). Added lines have oldLine null; context lines carry
 * the corresponding old-side number (GitLab needs both). Removed lines and deleted files are not
 * commentable.
 *
 * File headers (`--- ` / `+++ `) are accepted only outside a hunk, so an added line whose content
 * starts with `++` (diff prefix `+++ `) is not mistaken for the next file.
 */
export function diffLineMap(diffText) {
  const map = new Map();
  let file = null;
  let newLine = 0;
  let oldLine = 0;
  let remainOld = 0;
  let remainNew = 0;

  const inHunk = () => remainOld > 0 || remainNew > 0;

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null;
      remainOld = 0;
      remainNew = 0;
      continue;
    }

    const hunk = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      remainOld = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      remainNew = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }

    if (!inHunk()) {
      if (raw.startsWith('--- ')) continue;
      if (raw.startsWith('+++ ')) {
        const name = raw.slice(4).replace(/^b\//, '');
        file = name === '/dev/null' ? null : name;
        if (file) map.set(file, new Map());
        continue;
      }
    }

    if (raw.startsWith('\\')) continue;      // "\ No newline at end of file"

    if (raw.startsWith('-')) {
      remainOld = Math.max(0, remainOld - 1);
      oldLine += 1;
      continue;
    }

    if (!file) {
      if (raw.startsWith('+')) remainNew = Math.max(0, remainNew - 1);
      continue;
    }

    const lines = map.get(file);
    if (raw.startsWith('+')) {
      lines.set(newLine, null);
      newLine += 1;
      remainNew = Math.max(0, remainNew - 1);
      continue;
    }

    // context: ' ' prefix, or a leftover empty split
    lines.set(newLine, oldLine > 0 ? oldLine : null);
    newLine += 1;
    oldLine += 1;
    remainOld = Math.max(0, remainOld - 1);
    remainNew = Math.max(0, remainNew - 1);
  }
  return map;
}

/**
 * Pick a commentable anchor for a finding: { path, line, start_line?, old_line?, snapped }.
 * `old_line` is set only for context lines (GitLab requires it there; omit it on added lines).
 * Returns null when the file is not in the diff at all.
 */
export function anchor(map, finding) {
  const lines = map.get(finding.file);
  if (!lines || lines.size === 0) return null;

  const numbers = [...lines.keys()];
  const nearest = (n) => numbers.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best));
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

  const oldLine = lines.get(end);
  return {
    path: finding.file,
    line: end,
    start_line: start,
    ...(oldLine != null ? { old_line: oldLine } : {}),
    snapped: end !== wantedEnd,
  };
}
