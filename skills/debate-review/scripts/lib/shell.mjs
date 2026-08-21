// Small wrappers around child_process so the rest of the code reads as plain steps.
import { spawnSync } from 'node:child_process';

const BIG = 64 * 1024 * 1024;

/** Run a command. Throws on non-zero exit unless opts.allowFail. Returns the spawnSync result. */
export function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: BIG, ...opts });
  if (result.error) {
    throw new Error(`${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} → exit ${result.status}\n${result.stderr}`);
  }
  return result;
}

/** Run and return trimmed stdout. */
export function text(cmd, args, opts) {
  return run(cmd, args, opts).stdout.trim();
}

/** Run and parse stdout as JSON. */
export function json(cmd, args, opts) {
  return JSON.parse(text(cmd, args, opts));
}

/** Progress line on stderr (stdout is reserved for the result). */
export function log(message) {
  process.stderr.write(`[debate-review] ${message}\n`);
}
