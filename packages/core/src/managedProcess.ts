import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// One long-lived child process the dashboard owns, plus the plumbing every such
// process needs: a bounded log ring fed by stdout+stderr, a graceful stop, and a
// force kill that reaps the whole tree.
//
// The dashboard runs two of these — the pool Protector and the one-shot Editor —
// and before this they were copy-pasted: two `ChildProcess | null` handles, two
// identical 800-line ring buffers, two `taskkill /T /F`-on-win32-else-signal
// blocks. A fix to any of that plumbing (the ring cap, a non-Windows kill path, a
// graceful-stop timeout) had to be made twice and could silently drift.
//
// Tree-kill matters and is not incidental: the Protector spawns `claude` students
// of its own, so signalling only the direct child orphans them — they keep
// burning plan usage and holding git worktrees. `taskkill /T` walks the live tree
// on Windows; elsewhere the signal reaches the child and Node's default process
// group handling carries it down.

export interface ManagedProcessOptions {
  /** Human name used in the ring's own start/exit marker lines. */
  name: string;
  /** Max lines retained in the ring; older lines are dropped. */
  logCap?: number;
  /**
   * Where to ALSO persist every ring line. Omit to keep the ring in memory only.
   *
   * The ring alone was a diagnostic blind spot: it is served live at /api/log and
   * dies with the process, so a child that crashed left `exited code 1` in the
   * launcher log and nothing else anywhere — the actual error was only ever in a
   * buffer that no longer existed. A run you cannot read after it fails is a run
   * you cannot fix.
   */
  logFile?: string;
  /** Rotate the log file once it reaches this many bytes (default 5 MiB). */
  logFileCap?: number;
}

export class ManagedProcess {
  readonly name: string;
  private readonly logCap: number;
  private readonly logFile?: string;
  private readonly logFileCap: number;
  private logDirReady = false;
  private proc: ChildProcess | null = null;
  private readonly ring: string[] = [];

  constructor(opts: ManagedProcessOptions) {
    this.name = opts.name;
    this.logCap = opts.logCap ?? 800;
    this.logFile = opts.logFile;
    this.logFileCap = opts.logFileCap ?? 5 * 1024 * 1024;
  }

  isRunning(): boolean {
    return !!this.proc;
  }

  /** Newest `n` log lines (all of them when `n` is omitted). */
  logLines(n?: number): string[] {
    return n === undefined ? [...this.ring] : this.ring.slice(-n);
  }

  /**
   * Drop every retained line — used to start a run's log from empty.
   *
   * Clears the in-memory ring ONLY. The log file is the cross-run record and is
   * deliberately not truncated here: the reason to clear the ring is to show the
   * new run cleanly on the page, which is no reason to destroy the evidence from
   * the run before it — usually the one that just failed.
   */
  clearLog(): void {
    this.ring.length = 0;
  }

  /**
   * Append a chunk of process output. Splits on either newline convention (the
   * children are spawned on Windows too), drops blank lines, caps the ring, and
   * tees to `logFile` when one was configured.
   */
  push(chunk: string): void {
    const kept: string[] = [];
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      kept.push(line);
      this.ring.push(line);
      if (this.ring.length > this.logCap) this.ring.shift();
    }
    this.persist(kept);
  }

  /**
   * Append lines to the log file, timestamped so a stack trace can be lined up
   * with the launcher log and the engine's own status writes.
   *
   * Never throws. This runs on the child's 'data' handler inside the dashboard
   * process; a full disk or a locked file must cost the persisted copy, not the
   * dashboard — the ring is still live at /api/log either way.
   */
  private persist(lines: string[]): void {
    if (!this.logFile || !lines.length) return;
    try {
      if (!this.logDirReady) {
        mkdirSync(dirname(this.logFile), { recursive: true });
        this.logDirReady = true;
      }
      this.rotateIfFull();
      const stamp = new Date().toISOString();
      appendFileSync(this.logFile, lines.map((l) => `${stamp} ${l}\n`).join(''), 'utf8');
    } catch { /* see doc comment — a lost line must not take the dashboard down */ }
  }

  /**
   * Keep at most two generations (`engine.log` + `engine.log.1`). A long-running
   * pool emits a lot of student output, and an unbounded file is its own outage;
   * two generations is enough to still hold the run before the one that broke.
   */
  private rotateIfFull(): void {
    const file = this.logFile;
    if (!file || !existsSync(file)) return;
    if (statSync(file).size < this.logFileCap) return;
    const prev = `${file}.1`;
    if (existsSync(prev)) rmSync(prev); // renameSync onto an existing path fails on Windows
    renameSync(file, prev);
  }

  /**
   * Spawn the process and wire both output streams into the ring. Returns false
   * (spawning nothing) if one is already running — callers surface that as a
   * "stop it first" message rather than silently leaking a second child.
   */
  start(command: string, args: string[], options: SpawnOptions): boolean {
    if (this.proc) return false;
    const child = spawn(command, args, options);
    this.proc = child;
    child.stdout?.on('data', (b: Buffer) => this.push(b.toString()));
    child.stderr?.on('data', (b: Buffer) => this.push(b.toString()));
    // A ChildProcess with no 'error' listener re-throws a spawn failure as an
    // uncaught exception, which kills the DASHBOARD — so an ENOENT on the child's
    // interpreter (a thin GUI/Scheduled-Task PATH is the usual cause) took down
    // the one process that could have reported it. Record it and release the
    // handle instead, so Start can simply be pressed again.
    child.on('error', (err: Error) => {
      this.push(`=== ${this.name} failed to start: ${err.message} ===`);
      if (this.proc === child) this.proc = null;
    });
    child.on('close', (code) => {
      this.push(`=== ${this.name} exited (code ${code}) ===`);
      // Only clear if this is still the current child: a stop-then-immediate-start
      // would otherwise have the old child's late `close` null out the new handle.
      if (this.proc === child) this.proc = null;
    });
    return true;
  }

  /** Graceful stop. Returns false when nothing was running. */
  stop(): boolean {
    if (!this.proc || !this.proc.pid) return false;
    if (process.platform === 'win32') this.taskkill(this.proc.pid);
    else this.proc.kill('SIGTERM');
    return true;
  }

  /**
   * Force kill, for dashboard shutdown. Never throws — it runs from `process.on
   * ('exit')`, where an exception would mean the OTHER managed process never gets
   * reaped. Clears the handle immediately rather than waiting on `close`, which
   * will not be delivered during exit.
   */
  kill(): void {
    if (!this.proc || !this.proc.pid) return;
    try {
      if (process.platform === 'win32') this.taskkill(this.proc.pid);
      else this.proc.kill('SIGKILL');
    } catch { /* already gone */ }
    this.proc = null;
  }

  private taskkill(pid: number): void {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  }
}
