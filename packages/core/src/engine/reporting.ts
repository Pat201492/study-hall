import { reportsToClose, sweepDue, type OpenReport } from '../reportLifecycle.js';

// GitHub-side reports the engine files about ITSELF (watchdog quarantines,
// contested boards, kills) and the sweep that closes them once their subject
// resolves. Ported from v1 live.ts's report bodies; every write goes through an
// injected port so the engine test never touches gh.

export interface ReportPort {
  openIssueOnce(repo: string, title: string, body: string): Promise<{ url: string; created: boolean }>;
  openWatchdogReports(repo: string): Promise<OpenReport[]>;
  closeIssue(repo: string, n: number, comment: string): Promise<void>;
}

export function watchdogReport(item: string, repo: string, attempts: number): { title: string; body: string } {
  return {
    title: `[watchdog] ${item} on ${repo} never settled after ${attempts} attempts`,
    body: [
      `Study Hall worked \`${item}\` on \`${repo}\` **${attempts} times** without it settling.`,
      ``,
      `The attempt cap counts EVERY dispatch, so this report cannot tell you which`,
      `of two things happened — check which before spending time on it:`,
      ``,
      `1. **Oscillation.** The item kept changing state (a fix<->review ping-pong,`,
      `   where each review re-adds \`changes-requested\` and each fix clears it), so`,
      `   the no-progress detector never fired. The engine and its own reviewer`,
      `   disagree, and more attempts will not converge it. Read the review comments.`,
      `2. **Nothing to do.** Every dispatch found the work already present on the`,
      `   base branch and correctly produced no diff — which is charged identically.`,
      `   Check whether another PR already landed this scope; if so, close the item.`,
      ``,
      `It is labelled \`runner-error\`, so the board now emits no action for it.`,
      `Settle it by hand, then remove the label — or close the item.`,
    ].join('\n'),
  };
}

export function wedgedReport(key: string, repo: string, ticks: number): { title: string; body: string } {
  return {
    title: `[watchdog] ${key} on ${repo} wedged after ${ticks} attempts with no progress`,
    body: [
      `Study Hall dispatched \`${key}\` on \`${repo}\` **${ticks} times** and the item's state never changed`,
      `(same labels, same mergeability, same checks, same review decision).`,
      ``,
      `It is labelled \`runner-error\` and quarantined. Fix whatever blocks it, then remove the label.`,
    ].join('\n'),
  };
}

export function contestedReport(repo: string, churn: number): { title: string; body: string } {
  return {
    title: `[watchdog] board contested on ${repo}`,
    body: [
      `${churn} issue spec(s) on \`${repo}\` were rewritten between two ingests.`,
      ``,
      `Another writer is reshaping this board. Study Hall has paused dispatch on it`,
      `so implementers and reviewers stop building against different versions of a spec;`,
      `it resumes by itself once the board settles.`,
    ].join('\n'),
  };
}

export function killReport(reason: string, wedged: string[]): { title: string; body: string } {
  return {
    title: `[watchdog] engine stopped: ${reason}`,
    body: [
      `Study Hall stopped itself: ${reason}.`,
      ``,
      wedged.length ? `Wedged items at the time:\n${wedged.map((k) => `- \`${k}\``).join('\n')}` : 'No items were wedged.',
      ``,
      `Restart the engine once the cause is understood.`,
    ].join('\n'),
  };
}

export class Reporter {
  private lastSweep = 0;
  constructor(private readonly reportRepo: string, private readonly port: ReportPort, private readonly log: (m: string) => void = () => {}) {}

  async file(report: { title: string; body: string }): Promise<void> {
    if (!this.reportRepo) return;
    try {
      const r = await this.port.openIssueOnce(this.reportRepo, report.title, report.body);
      this.log(`watchdog ${r.created ? 'filed report' : 'report already open'}: ${r.url}`);
    } catch (e) {
      this.log(`watchdog report failed: ${(e as Error).message}`);
    }
  }

  /** Close reports whose subject has left a board we can see. Throttled. */
  async sweep(openByRepo: Map<string, Set<string>>, now: number): Promise<number> {
    if (!this.reportRepo || !sweepDue(this.lastSweep, now)) return 0;
    this.lastSweep = now;
    let closed = 0;
    try {
      const reports = await this.port.openWatchdogReports(this.reportRepo);
      for (const { report, subject } of reportsToClose(reports, openByRepo)) {
        await this.port.closeIssue(this.reportRepo, report, `\`${subject.kind}-${subject.number}\` on \`${subject.repo}\` is no longer open — closing this report.`).catch(() => undefined);
        closed += 1;
      }
    } catch (e) {
      this.log(`report sweep failed: ${(e as Error).message}`);
    }
    return closed;
  }
}
