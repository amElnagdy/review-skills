// Project-level agent config that a reviewer CLI may load from cwd and execute
// (hooks, plugins, MCP servers). Kept in one list: strip these from a disposable
// PR-head / --local snapshot after the diff is computed, never from the user's tree.
import fs from 'node:fs';
import path from 'node:path';

export const AGENT_CONFIG_PATHS = Object.freeze([
  '.claude',
  '.codex',
  '.opencode',
  'opencode.json',
  'opencode.jsonc',
  '.mcp.json',
  '.cursor',
  '.gemini',
  '.pi',
  '.grok',
  '.vscode/mcp.json',
]);

function relParts(rel) {
  if (!rel || typeof rel !== 'string' || path.isAbsolute(rel)) {
    throw new Error(`unsafe agent config path: ${rel}`);
  }
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`unsafe agent config path: ${rel}`);
  }
  return parts;
}

/** Remove a file or directory. Symlinks are unlinked; their targets are not walked. */
function removeNoFollow(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
    throw error;
  }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    for (const name of fs.readdirSync(abs)) {
      removeNoFollow(path.join(abs, name));
    }
    fs.rmdirSync(abs);
    return;
  }
  fs.unlinkSync(abs);
}

function removeAgentPath(root, rel) {
  const parts = relParts(rel);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }
    if (st.isSymbolicLink()) {
      fs.unlinkSync(cur);
      return;
    }
    if (i === parts.length - 1) {
      removeNoFollow(cur);
      return;
    }
    if (!st.isDirectory()) return;
  }
}

/**
 * Delete known agent-config paths under `root`. Safe for a missing path.
 * `protect` is a tree that must not be modified (the user's clone / working tree).
 */
export function sanitizeAgentConfig(root, { protect } = {}) {
  if (protect != null && fs.realpathSync(root) === fs.realpathSync(protect)) {
    throw new Error('refusing to strip agent config from the protected tree');
  }
  for (const rel of AGENT_CONFIG_PATHS) removeAgentPath(root, rel);
}

/**
 * Repo-root agent-config paths a reviewer CLI in `root` would resolve.
 * Intermediate symlinks are followed (same as the CLI); the last hop uses lstat
 * so a dangling symlink still counts as present. Used only to warn on `--check`.
 */
export function presentAgentConfig(root) {
  const found = [];
  for (const rel of AGENT_CONFIG_PATHS) {
    try {
      fs.lstatSync(path.join(root, ...relParts(rel)));
      found.push(rel);
    } catch {
      // absent
    }
  }
  return found;
}
