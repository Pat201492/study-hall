import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

// Static file serving for webui/, read from disk on every request (no build
// step, edits show on reload) with a containment check so `..` cannot escape the
// directory. Unknown non-API paths fall back to index.html so the SPA can route.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  const base = resolve(root);
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  // A `..` segment is never legitimate here; refuse before normalize() can clamp
  // it back inside the root and hand the SPA fallback to a traversal attempt.
  if (rel.split(/[\\/]/).includes('..')) { res.writeHead(403); res.end('forbidden'); return true; }
  let file = resolve(join(base, normalize(rel)));
  if (!file.startsWith(base + sep) && file !== base) {
    res.writeHead(403); res.end('forbidden'); return true;
  }
  let stat = safeStat(file);
  if (!stat || !stat.isFile()) {
    if (extname(rel)) return false;           // a missing asset is a real 404
    file = join(base, 'index.html');          // SPA fallback
    stat = safeStat(file);
    if (!stat) return false;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(stat.size),
    'cache-control': 'no-store',
  });
  if ((req.method || 'GET').toUpperCase() === 'HEAD') { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}

function safeStat(p: string) {
  try { return statSync(p); } catch { return null; }
}
