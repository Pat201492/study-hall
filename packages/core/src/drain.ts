import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Soft stop ("finish what's running, start nothing new").
//
// Stopping the pool today is a tree-kill: `taskkill /T /F` reaps the Protector
// and every `claude` student under it. That is the right tool for "stop NOW",
// but it throws away whatever those students had done — an implement run minutes
// from opening its PR dies with nothing to show, and the plan usage it spent is
// simply gone. A soft stop is the other half of that pair: stop dispatching,
// let the work already in flight land, then exit on its own.
//
// The signal is a FILE rather than a socket or a signal number because the two
// participants are separate processes with no channel between them: the
// dashboard owns the Protector as a spawned child and talks to it exclusively
// through the filesystem (status.json out, config.json in). A file also survives
// a dashboard restart, so a soft stop requested at 2am is still in force at 3am
// when something restarts the page — which is exactly what an operator means by
// "wind down when you're done".
//
// Windows has no usable SIGTERM for a console child, so the signal path the rest
// of the world would use is not available here anyway.

/** The state dir the flag lives in — same root as status.json and the schedule. */
export function drainFlagPath(dir: string = join(homedir(), '.claude-study-room')): string {
  return join(dir, 'drain.flag');
}

/**
 * Ask the running engine to wind down. Contents are the request time, purely so
 * a human reading the state dir can tell a fresh request from a stale one.
 */
export function requestDrain(file: string = drainFlagPath()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, new Date().toISOString(), 'utf8');
}

/**
 * Withdraw the request, or clear a stale one.
 *
 * Clearing is as important as setting: a flag left behind by a killed engine
 * would make the NEXT pool start wind down immediately and look broken. Both
 * `startPool()` and the engine's own drain-complete exit clear it.
 */
export function clearDrain(file: string = drainFlagPath()): void {
  try { if (existsSync(file)) rmSync(file); } catch { /* a flag we cannot remove is reported by the caller's next read */ }
}

/** Is a soft stop currently requested? */
export function drainRequested(file: string = drainFlagPath()): boolean {
  return existsSync(file);
}
