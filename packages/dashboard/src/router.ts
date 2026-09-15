import type { IncomingMessage, ServerResponse } from 'node:http';

// A small router for the dashboard's node:http server. Replaces v1's exact-match
// `ROUTES["METHOD /path"]` table, which keyed on the RAW url (query string
// included) and so could never express `/api/runs?repo=x` or `/api/runs/:id`, and
// whose dispatcher always serialised the handler's return value, so no handler
// could own a streaming response. Two v1 behaviours are kept on purpose: a 500
// that keeps the server up, and an explicit 404 for unknown /api paths that names
// the likely cause (a stale process serving fresh static files).

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body for POST/PUT/PATCH; `{}` when empty or not JSON. */
  body: Record<string, unknown>;
  /** Take ownership of the response as a Server-Sent Events stream. */
  sse(): SseStream;
  /** Take ownership of the response (the handler writes it itself). */
  own(): ServerResponse;
}

export interface SseStream {
  send(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
  onClose(fn: () => void): void;
}

export type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${source}/?$`), keys };
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly logger: (msg: string) => void;

  constructor(opts: { log?: (msg: string) => void } = {}) {
    this.logger = opts.log ?? ((m) => console.error(m));
  }

  add(method: string, path: string, handler: Handler): this {
    const { pattern, keys } = compile(path);
    this.routes.push({ method: method.toUpperCase(), pattern, keys, handler });
    return this;
  }
  get(path: string, handler: Handler): this { return this.add('GET', path, handler); }
  post(path: string, handler: Handler): this { return this.add('POST', path, handler); }
  put(path: string, handler: Handler): this { return this.add('PUT', path, handler); }
  delete(path: string, handler: Handler): this { return this.add('DELETE', path, handler); }

  /** Returns true when a route handled the request (or answered 404/500 for an
   *  /api path); false when the caller should fall through to static files. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const method = (req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    // Match on the ENCODED pathname so an encoded slash inside a param
    // (`/api/runs/abc%2F1`) stays one segment; params are decoded afterwards.
    const path = url.pathname;

    let matched: Route | undefined;
    let params: Record<string, string> = {};
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      matched = r;
      params = Object.fromEntries(r.keys.map((k, i) => [k, safeDecode(m[i + 1])]));
      break;
    }

    if (!matched) {
      if (path.startsWith('/api/')) {
        sendJson(res, 404, {
          ok: false,
          unknownRoute: `${method} ${path}`,
          msg: 'No such API route. If this page was just updated, the dashboard process is stale — restart it.',
        });
        return true;
      }
      return false;
    }

    let owned = false;
    const ctx: RouteContext = {
      req, res, method, path, params, query: url.searchParams,
      body: await readJsonBody(req),
      own: () => { owned = true; return res; },
      sse: () => { owned = true; return openSse(res); },
    };

    try {
      const out = await matched.handler(ctx);
      if (owned) return true;
      const store = method === 'GET' ? 'no-store' : undefined;
      // A handler may set a non-200 status (e.g. 404 for "no such run") and still
      // return a JSON body; the default stays 200.
      const status = res.statusCode && res.statusCode !== 200 ? res.statusCode : 200;
      sendJson(res, status, out === undefined ? { ok: true } : out, store);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.logger(`route ${method} ${path} failed: ${detail}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, msg: detail });
      else if (!res.writableEnded) res.end();
    }
    return true;
  }
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, cacheControl?: string): void {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  };
  if (cacheControl) headers['cache-control'] = cacheControl;
  res.writeHead(status, headers);
  res.end(payload);
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body over ${MAX_BODY_BYTES} bytes`);
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return {};
  }
}

function openSse(res: ServerResponse): SseStream {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': open\n\n');
  let closed = false;
  const closers = new Set<() => void>();
  const finish = (): void => {
    if (closed) return;
    closed = true;
    for (const fn of closers) { try { fn(); } catch { /* ignore */ } }
    if (!res.writableEnded) res.end();
  };
  res.on('close', finish);
  return {
    send(event, data) {
      if (closed) return;
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      res.write(`event: ${event}\ndata: ${text.replace(/\n/g, '\ndata: ')}\n\n`);
    },
    comment(text) { if (!closed) res.write(`: ${text}\n\n`); },
    close: finish,
    get closed() { return closed; },
    onClose(fn) { closers.add(fn); },
  };
}
