#!/usr/bin/env node
// debate-review · on-pr-created.mjs
//
// Hook entry point. Reads a Claude Code PostToolUse payload on stdin, and if the command that just
// ran was `gh pr create` / `glab mr create`, starts review-pr.mjs in the background on the PR URL
// it printed. Exits immediately so the orchestrator is never blocked.
//
// Other orchestrators can call it the same way: pipe JSON like
//   {"tool_input":{"command":"gh pr create ..."},"tool_response":"https://github.com/o/r/pull/12"}
// or skip it entirely and run review-pr.mjs <url> themselves.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEW = path.join(HERE, 'review-pr.mjs');
const EXTRA_ARGS = (process.env.DEBATE_REVIEW_ARGS || '').split(' ').filter(Boolean);

let payload = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { payload += chunk; });
process.stdin.on('end', () => {
  let event;
  try { event = JSON.parse(payload); } catch { process.exit(0); }

  const command = String(event.tool_input?.command || '');
  if (!/\b(gh\s+pr\s+create|glab\s+mr\s+create)\b/.test(command)) process.exit(0);

  const response = typeof event.tool_response === 'string' ? event.tool_response : JSON.stringify(event.tool_response || '');
  const url = response.match(/https?:\/\/[^\s"']+\/(?:pull|-\/merge_requests)\/\d+/);
  if (!url) process.exit(0);

  const logDir = path.join(os.homedir(), '.cache', 'debate-review', 'hook-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${Date.now()}.log`);
  const logFd = fs.openSync(logFile, 'a');

  const child = spawn('node', [REVIEW, url[0], ...EXTRA_ARGS], {
    cwd: event.cwd || process.cwd(),
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  process.stdout.write(`debate-review started for ${url[0]} (log: ${logFile})\n`);
  process.exit(0);
});
