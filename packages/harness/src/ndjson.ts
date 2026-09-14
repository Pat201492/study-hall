// NDJSON framer with partial-line carry. Ported from claude-study-room's
// cliStudent.ts `consume()`: a chunk boundary can fall mid-line, so the trailing
// partial line is kept until the next chunk (or flushed at close). Non-JSON lines
// are skipped, never thrown on — a CLI may print a warning between events.

export class NdjsonFramer {
  private pending = '';

  /** Feed a chunk; returns every complete JSON object it contained, in order.
   *  `onLine` receives each raw complete line (for transcript sinks). */
  push(chunk: string, onLine?: (line: string) => void): Record<string, unknown>[] {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    const out: Record<string, unknown>[] = [];
    for (const line of lines) {
      const t = line.replace(/\r$/, '').trim();
      if (!t) continue;
      onLine?.(t);
      const parsed = tryParse(t);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** Flush a final unterminated line (call on process close). */
  flush(onLine?: (line: string) => void): Record<string, unknown>[] {
    const t = this.pending.replace(/\r$/, '').trim();
    this.pending = '';
    if (!t) return [];
    onLine?.(t);
    const parsed = tryParse(t);
    return parsed ? [parsed] : [];
  }
}

function tryParse(t: string): Record<string, unknown> | null {
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Number or 0 — usage fields default to 0 so telemetry never NaNs on a sparse event. */
export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
