// Minimal timestamped logger. Colors kept ANSI-simple so it reads fine in a .bat window.
const c = {
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

// UTC, and SAYS so. v1 printed `toISOString()` with the `T` swapped for a space
// and the `Z` sliced off — a UTC instant formatted to look exactly like a local
// wall-clock time. Every operational rule (blackout window, capacity reset, the
// 22:00 crash hour) is local, the launcher log is local, GitHub is UTC, so
// correlating any two of them needed an undocumented 4-hour mental conversion
// (the 2026-08-22T02 segfault burst IS the 22:00 local hour). Keeping the `Z`
// costs one character and removes the trap; blackout.ts deliberately stays on
// local wall clock because that is the clock the operator's rule is stated in.
export function timestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function ts(): string {
  return timestamp();
}

export const log = {
  info: (m: string) => console.log(`${c.gray(ts())} ${m}`),
  ok: (m: string) => console.log(`${c.gray(ts())} ${c.green('✓')} ${m}`),
  warn: (m: string) => console.log(`${c.gray(ts())} ${c.yellow('!')} ${m}`),
  err: (m: string) => console.log(`${c.gray(ts())} ${c.red('✗')} ${m}`),
  step: (m: string) => console.log(`${c.gray(ts())} ${c.cyan('▸')} ${m}`),
};
