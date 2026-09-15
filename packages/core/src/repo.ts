// Repo identity: "owner/name".
//
// Local copy of v1 config.ts:361-369 — the one config helper github.ts needs.
// config.ts itself (file loading, defaults, the whole StudyRoomConfig shape) is
// not ported into core, so the pure modules keep this three-line normaliser
// rather than a dependency on the configuration package.

// Accepts "owner/name" or a full github.com URL; throws on anything else.
export function normalizeRepo(input: string): string {
  const s = input.trim();
  if (!s) throw new Error('Repo cannot be empty.');
  const m = s.match(/github\.com[/:]([^/]+\/[^/.]+)/i);
  if (m) return m[1].replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s;
  throw new Error(`Not a valid repo: ${s}`);
}
