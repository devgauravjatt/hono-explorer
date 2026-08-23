/** biome-ignore-all lint/suspicious/noExplicitAny: <no need> */
import type { Hono, MiddlewareHandler } from 'hono';
import { getRouterName } from 'hono/dev';
import { streamSSE } from 'hono/streaming';

/* ── types ─────────────────────────────────────────────────────────────── */

export type Span = {
  id: string;
  parentId: string | null;
  name: string;
  /** ms since the request started */
  startMs: number;
  /** ms this span took, including anything nested inside it */
  durationMs: number;
  /** whatever you attached */
  meta?: Record<string, unknown>;
};

export type Trace = {
  id: string;
  startedAt: number;
  method: string;
  url: string;
  path: string;
  routePath: string;
  params: Record<string, string>;
  query: Record<string, string>;
  chain: { method: string; path: string; handler: string }[];
  spans: Span[];
  /** trace-level bag filled via c.var.trace.set() or trace.data.x = … */
  data: Record<string, unknown>;
  /** keys whose value was literally undefined — JSON would have dropped them */
  dataUndefined: string[];
  reqHeaders: Record<string, string>;
  reqCookies: Record<string, string>;
  reqBody?: string;
  status: number;
  resHeaders: Record<string, string>;
  /** raw Set-Cookie strings, one per cookie */
  resCookies: string[];
  resBody?: string;
  durationMs: number;
  error?: { name: string; message: string; stack?: string };
};

/**
 * Requests the browser makes on its own, not by your API's doing.
 * Chrome asks for the devtools file on every page load while DevTools is open.
 */
export const NOISE = [
  '/.well-known/appspecific/com.chrome.devtools.json',
  '/favicon.ico',
];

export type ExplorerOptions = {
  basePath?: string;
  max?: number;
  captureBody?: boolean;
  maxBodyBytes?: number;
  /** extra paths to never trace (prefix match), on top of NOISE */
  ignore?: string[];
  /**
   * Skip requests the browser makes on its own — Chrome DevTools' workspace
   * probe and favicon. Default true. Set false to see everything.
   */
  ignoreNoise?: boolean;
  /**
   * Which header names get their value masked. Default /authorization|x-api-key/i.
   * Pass false to show every header as-is. Cookies are never masked.
   */
  redact?: RegExp | false;
  token?: string;
};

export type UiOptions = {
  /**
   * Include the explorer's own routes (/__explorer/*) in the routes map.
   * Default false, so the count reflects your app only.
   */
  selfRoutes?: boolean;
  /**
   * highlight.js theme for the detail panel — any stylesheet name from
   * cdnjs (e.g. 'github-dark', 'nord', 'tokyo-night-dark').
   * Pass false to skip highlighting; the panel still renders, just plain.
   */
  highlight?: string | false;
  /**
   * Serve highlight.js from somewhere else — a self-hosted copy for offline
   * work. Must contain highlight.min.js and styles/<theme>.min.css.
   * Subresource integrity is only applied to the default CDN.
   */
  highlightCdn?: string;
};

/** Use this as your Hono generic so `c.var.trace` is typed. */
export type ExplorerEnv = { Variables: { trace: TraceCtx } };

/* ── helpers ───────────────────────────────────────────────────────────── */

const now = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

const round = (n: number) => Math.round(n * 100) / 100;

const rid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** headers whose value is masked in the panel; override with the redact option */
const REDACT = /authorization|x-api-key/i;

const headersToObject = (h: Headers, redact: RegExp | false = REDACT) => {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    // biome-ignore lint/complexity/useOptionalChain: <no need>
    out[k] = redact && redact.test(k) ? '••••••' : v;
  });
  return out;
};

const parseCookies = (raw: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out[name] = part.slice(i + 1).trim();
  }
  return out;
};

const setCookies = (h: Headers): string[] => {
  const anyH = h as any;
  if (typeof anyH.getSetCookie === 'function') return anyH.getSetCookie();
  const one = h.get('set-cookie');
  return one ? [one] : [];
};

async function safeBody(
  src: Request | Response,
  maxBytes: number,
): Promise<string | undefined> {
  const type = src.headers.get('content-type') ?? '';
  if (!/json|text|xml|urlencoded/.test(type)) return undefined;
  const len = Number(src.headers.get('content-length') ?? 0);
  if (len > maxBytes) return `[skipped: ${len} bytes]`;
  try {
    const text = await src.clone().text();
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}…` : text;
  } catch {
    return undefined;
  }
}

/* ── per-request trace context — this is what c.var.trace holds ────────── */

export class TraceCtx {
  readonly spans: Span[] = [];
  readonly data: Record<string, unknown> = {};
  private stack: string[] = [];
  private seq = 0;
  private t0 = now();

  private open(name: string, meta?: Record<string, unknown>): Span {
    const span: Span = {
      id: String(++this.seq),
      parentId: this.stack.length ? this.stack[this.stack.length - 1] : null,
      name,
      startMs: round(now() - this.t0),
      durationMs: 0,
      meta,
    };
    this.spans.push(span);
    this.stack.push(span.id);
    return span;
  }

  private close(span: Span) {
    span.durationMs = round(now() - this.t0 - span.startMs);
    // remove by identity, not by pop — concurrent spans may interleave
    const i = this.stack.lastIndexOf(span.id);
    if (i >= 0) this.stack.splice(i, 1);
  }

  /** Time an operation: await c.var.trace.span('db:findUser', () => db.find(id)) */
  span<T>(
    name: string,
    fn: () => T | Promise<T>,
    meta?: Record<string, unknown>,
  ): Promise<T>;
  /** Or hold a handle: const s = c.var.trace.span('cache'); … ; s.end({ hit }) */
  span(
    name: string,
    fn?: undefined,
    meta?: Record<string, unknown>,
  ): { end: (meta?: Record<string, unknown>) => void };
  span(name: string, fn?: any, meta?: Record<string, unknown>): any {
    const span = this.open(name, meta);

    if (typeof fn !== 'function') {
      return {
        end: (m?: Record<string, unknown>) => {
          if (m) span.meta = { ...span.meta, ...m };
          this.close(span);
        },
      };
    }

    const done = (err?: unknown) => {
      if (err) {
        span.meta = {
          ...span.meta,
          error: String((err as Error)?.message ?? err),
        };
      }
      this.close(span);
    };

    try {
      const out = fn();
      if (out && typeof out.then === 'function') {
        return out.then(
          (v: unknown) => {
            done();
            return v;
          },
          (e: unknown) => {
            done(e);
            throw e;
          },
        );
      }
      done();
      return Promise.resolve(out);
    } catch (e) {
      done(e);
      throw e;
    }
  }

  /** Attach extra info to the innermost span that is still open. */
  annotate(meta: Record<string, unknown>) {
    const id = this.stack[this.stack.length - 1];
    const span = this.spans.find((s) => s.id === id);
    if (span) span.meta = { ...span.meta, ...meta };
  }

  /** Put anything on the trace itself — shows up in the detail panel. */
  set(key: string, value: unknown) {
    this.data[key] = value;
    return this;
  }
}

/* ── store ─────────────────────────────────────────────────────────────── */

class TraceStore {
  private buf: Trace[] = [];
  private subs = new Set<(t: Trace) => void>();
  constructor(private max: number) {}

  push(t: Trace) {
    this.buf.push(t);
    if (this.buf.length > this.max) this.buf.shift();
    for (const fn of this.subs) {
      try {
        fn(t);
      } catch {
        /* a dead subscriber must not break the request */
      }
    }
  }
  list(limit = this.max) {
    return this.buf.slice(-limit).reverse();
  }
  get(id: string) {
    return this.buf.find((t) => t.id === id);
  }
  clear() {
    this.buf = [];
  }
  subscribe(fn: (t: Trace) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

/* ── the explorer ──────────────────────────────────────────────────────── */

export function createExplorer(options: ExplorerOptions = {}) {
  const {
    basePath = '/__explorer',
    max = 200,
    captureBody = true,
    maxBodyBytes = 32_000,
    ignore = [],
    ignoreNoise = true,
    redact = REDACT,
    token,
  } = options;

  const store = new TraceStore(max);
  const skipList = ignoreNoise ? [...NOISE, ...ignore] : ignore;
  const skip = (path: string) =>
    path.startsWith(basePath) || skipList.some((p) => path.startsWith(p));

  /** Register with app.use('*', …) as the very first middleware. */
  const tracer = (): MiddlewareHandler => async (c, next) => {
    if (skip(c.req.path)) return next();

    const t0 = now();
    const ctx = new TraceCtx();
    c.set('trace', ctx);

    const trace: Partial<Trace> = {
      id: rid(),
      startedAt: Date.now(),
      method: c.req.method,
      url: c.req.url,
      path: c.req.path,
      query: c.req.query(),
      reqHeaders: headersToObject(c.req.raw.headers, redact),
      reqCookies: parseCookies(c.req.raw.headers.get('cookie')),
    };

    if (captureBody && c.req.raw.body) {
      trace.reqBody = await safeBody(c.req.raw, maxBodyBytes);
    }

    try {
      await next();
    } catch (err) {
      const e = err as Error;
      trace.error = { name: e.name, message: e.message, stack: e.stack };
      throw err;
    } finally {
      const req = c.req as any;
      trace.durationMs = round(now() - t0);
      trace.routePath = req.routePath ?? '';
      trace.params = c.req.param() ?? {};
      trace.chain = (req.matchedRoutes ?? []).map((r: any) => ({
        method: r.method,
        path: r.path,
        handler: r.handler?.name || 'anonymous',
      }));
      trace.spans = ctx.spans;
      // JSON.stringify silently drops undefined values, so keep the key names
      const data: Record<string, unknown> = {};
      const undef: string[] = [];
      for (const [k, v] of Object.entries(ctx.data)) {
        if (v === undefined) {
          data[k] = null;
          undef.push(k);
        } else {
          data[k] = v;
        }
      }
      trace.data = data;
      trace.dataUndefined = undef;
      trace.status = c.res?.status ?? 0;
      trace.resHeaders = c.res ? headersToObject(c.res.headers, redact) : {};
      trace.resCookies = c.res ? setCookies(c.res.headers) : [];
      if (captureBody && c.res) {
        trace.resBody = await safeBody(c.res, maxBodyBytes);
      }
      store.push(trace as Trace);
    }
  };

  /** Mount: app.route('/__explorer', explorer.ui(app, { selfRoutes: false })) */
  const ui = (app: Hono<any, any, any>, uiOptions: UiOptions = {}) => {
    const selfRoutes = uiOptions.selfRoutes ?? false;
    const theme =
      uiOptions.highlight === undefined ? 'atom-one-dark' : uiOptions.highlight;
    const cdn = uiOptions.highlightCdn ?? HLJS_CDN;
    const hljs =
      theme === false ? false : { cdn, theme, sri: cdn === HLJS_CDN };
    const sub = new (app.constructor as new () => Hono)();

    if (token) {
      sub.use('*', async (c, next) => {
        if (c.req.query('token') !== token) return c.text('Forbidden', 403);
        await next();
      });
    }

    sub.get('/', (c) => c.html(homePage(basePath, token, hljs)));
    sub.get('/routes', (c) => c.html(routesPage(basePath, token)));

    sub.get('/api/routes', (c) => {
      const all = (app as any).routes ?? [];
      const routes = selfRoutes
        ? all
        : all.filter((r: any) => !String(r.path).startsWith(basePath));
      return c.json({
        router: getRouterName(app),
        count: routes.length,
        hidden: all.length - routes.length,
        routes: routes.map((r: any) => ({
          method: r.method,
          path: r.path,
          handler: r.handler?.name || 'anonymous',
        })),
      });
    });

    sub.get('/api/history', (c) =>
      c.json(store.list(Number(c.req.query('limit') ?? max))),
    );

    sub.get('/api/history/:id', (c) => {
      const t = store.get(c.req.param('id'));
      return t ? c.json(t) : c.json({ error: 'not found' }, 404);
    });

    sub.post('/api/clear', (c) => {
      store.clear();
      return c.json({ ok: true });
    });

    sub.get('/api/stream', (c) =>
      streamSSE(c, async (stream) => {
        const queue: Trace[] = [];
        const unsub = store.subscribe((t) => queue.push(t));
        try {
          await stream.writeSSE({ event: 'ready', data: '1' });
          while (!stream.aborted && !stream.closed) {
            while (queue.length) {
              await stream.writeSSE({
                event: 'trace',
                data: JSON.stringify(queue.shift()),
              });
            }
            await stream.sleep(200);
          }
        } finally {
          unsub();
        }
      }),
    );

    return sub;
  };

  return { tracer, ui, store };
}

/* ── UI ────────────────────────────────────────────────────────────────── */

const HLJS_VERSION = '11.12.0';
const HLJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/${HLJS_VERSION}`;
/** from the official cdn-release DIGESTS.md for this version */
const HLJS_SRI =
  'sha384-wjfDDhOPPdjtva8vWBhWeVprSpmxisEu5aYT3q1JyACqXpdKpo3PWZTMVq24MBix';

type HljsConfig = { cdn: string; theme: string; sri: boolean };

const hljsTags = (h: HljsConfig | false) =>
  h
    ? `<link rel="stylesheet" href="${h.cdn}/styles/${h.theme}.min.css">` +
      `<script src="${h.cdn}/highlight.min.js"` +
      (h.sri ? ` integrity="${HLJS_SRI}" crossorigin="anonymous"` : '') +
      `></script>`
    : '';

const CSS = `
  :root{
    --ink:#0b0d13; --panel:#12151f; --line:#232838; --dim:#6b7392;
    --fg:#d7dcf0; --live:#ffb454; --get:#5ac8fa; --post:#7ee787;
    --put:#d2a8ff; --del:#ff7b72; --all:#6b7392;
    --mono:ui-monospace,"JetBrains Mono","SFMono-Regular",Menlo,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ink);color:var(--fg);font:13px/1.55 var(--mono)}
  header{display:flex;gap:14px;align-items:baseline;padding:12px 16px;
         border-bottom:1px solid var(--line);flex-wrap:wrap}
  header b{letter-spacing:.14em;text-transform:uppercase;font-weight:600}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--live);display:inline-block;
       animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.25}}
  @media (prefers-reduced-motion:reduce){.dot{animation:none}}
  .meta{color:var(--dim)}
  .spacer{margin-left:auto}
  main{padding:14px 16px;max-width:1200px}
  h2{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:18px 0 10px}
  h2:first-child{margin-top:0}
  a.btn,button{background:var(--panel);color:var(--fg);border:1px solid var(--line);
    border-radius:4px;padding:6px 10px;font:inherit;cursor:pointer;text-decoration:none;
    display:inline-block}
  a.btn:hover,button:hover{border-color:var(--dim)}
  a.btn:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--get);outline-offset:2px}
  button.on{border-color:var(--live);color:var(--live)}
  input{background:var(--panel);color:var(--fg);border:1px solid var(--line);
    border-radius:4px;padding:7px 10px;font:inherit;width:100%}
  .m{font-size:10px;padding:1px 5px;border-radius:3px;border:1px solid currentColor;
     min-width:44px;text-align:center;display:inline-block}
  .GET{color:var(--get)}.POST{color:var(--post)}.PUT,.PATCH{color:var(--put)}
  .DELETE{color:var(--del)}.ALL{color:var(--all)}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;color:var(--dim);font-weight:400;font-size:11px;
     text-transform:uppercase;letter-spacing:.1em;padding:0 8px 6px 0}
  td{padding:4px 8px 4px 0;border-top:1px solid var(--line);white-space:nowrap}
  tr.row{cursor:pointer}
  tr.row:hover td{background:var(--panel)}
  tr.row.fresh td{background:#1a1c15}
  tr.row.on td{background:var(--panel)}
  .s2{color:var(--post)}.s3{color:var(--put)}.s4{color:var(--live)}.s5{color:var(--del)}
  pre{background:var(--panel);border:1px solid var(--line);border-radius:4px;
      padding:10px;overflow:auto;max-height:230px;white-space:pre-wrap;word-break:break-word}
  .wf{border:1px solid var(--line);border-radius:4px;background:var(--panel);padding:8px}
  .wfrow{display:grid;grid-template-columns:1fr 200px;gap:12px;align-items:center;padding:2px 0}
  .wflab{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .wfbar{position:relative;height:11px;background:#0b0d13;border-radius:2px}
  .wfbar i{position:absolute;top:0;bottom:0;border-radius:2px;background:var(--live);opacity:.85}
  .wfms{color:var(--dim);font-size:11px}
  .filter{color:var(--live);text-transform:none;letter-spacing:0}
  .tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px}
  .tabs button{padding:4px 9px;font-size:12px}
  .tabs button.on{border-color:var(--live);color:var(--live)}
  .tabs button .n{color:var(--dim);font-size:11px}
  .tabs button.on .n{color:var(--live);opacity:.7}
  .tabp{display:none}
  .tabp.on{display:block}
  .none{color:var(--dim);padding:8px 0}
  .tree{color:var(--line);white-space:pre}
  .kv{border:1px solid var(--line);border-radius:4px;background:var(--panel);padding:6px 10px}
  .kvr{display:grid;grid-template-columns:180px 1fr;gap:12px;padding:2px 0}
  .kvr .k{color:var(--get)}
  .kvu{color:var(--dim);font-style:italic}
  .empty{color:var(--dim);padding:24px 0}
  /* routes map */
  .bar{display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap}
  .bar .grow{flex:1;min-width:220px}
  .grp{border:1px solid var(--line);border-radius:4px;margin-bottom:8px;overflow:hidden}
  .grph{display:flex;gap:10px;align-items:center;width:100%;text-align:left;
        background:var(--panel);border:0;border-radius:0;padding:8px 10px}
  .grph .n{color:var(--dim);margin-left:auto}
  .grpb{padding:2px 0}
  .rt{display:grid;grid-template-columns:52px 1fr auto;gap:10px;align-items:center;
      width:100%;text-align:left;background:none;border:0;border-radius:0;padding:4px 10px}
  .rt:hover{background:var(--panel)}
  .rt .h{color:var(--dim);font-size:11px}
  .rt .p b{color:var(--live);font-weight:400}
  .seg{color:var(--dim)}
  /* let the hljs theme colour the tokens, but keep our own panel chrome */
  pre .hljs,pre code.hljs{background:transparent;padding:0}
`;

const shell = (
  title: string,
  header: string,
  body: string,
  script: string,
  head = '',
) =>
  `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${CSS}</style>${head}</head><body>
<header>${header}</header>
<main>${body}</main>
<script>${script}</script>
</body></html>`;

const PRELUDE = (base: string, q: string) => `
const BASE=${JSON.stringify(base)}, Q=${JSON.stringify(q)};
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const dur=n=>n>=1000?(n/1000).toFixed(2)+'s':(Math.round(n*100)/100)+'ms';
const qs=k=>new URLSearchParams(location.search).get(k);
/* highlight.js if it loaded, plain escaped text if it did not */
const code=(s,lang)=>{
  try{ if(window.hljs) return window.hljs.highlight(String(s),{language:lang||'json',ignoreIllegals:true}).value; }catch(e){}
  return esc(s);
};
const json=o=>code(JSON.stringify(o,null,2),'json');
const bodyCode=t=>{ try{ return json(JSON.parse(t)); }catch(e){ return esc(t); } };
/* groups: [{label, count, html}] — first pane is open */
let tabSeq=0;
function tabs(groups){
  const g='tg'+(++tabSeq);
  const heads=groups.map((x,i)=>
    '<button data-g="'+g+'" data-i="'+i+'" class="'+(i?'':'on')+'">'+esc(x.label)+
    (x.count!=null?' <span class="n">'+x.count+'</span>':'')+'</button>').join('');
  const panes=groups.map((x,i)=>
    '<div class="tabp'+(i?'':' on')+'" data-g="'+g+'" data-i="'+i+'">'+
    (x.html||'<div class="none">None</div>')+'</div>').join('');
  return '<div class="tabs">'+heads+'</div>'+panes;
}
function wireTabs(root){
  root.querySelectorAll('.tabs button').forEach(b=>{
    b.onclick=()=>{
      const g=b.dataset.g;
      root.querySelectorAll('.tabs button[data-g="'+g+'"]').forEach(x=>x.classList.remove('on'));
      b.classList.add('on');
      root.querySelectorAll('.tabp[data-g="'+g+'"]').forEach(p=>
        p.classList.toggle('on', p.dataset.i===b.dataset.i));
    };
  });
}
`;

/* ── page 1: requests ──────────────────────────────────────────────────── */

const homePage = (
  base: string,
  token?: string,
  hljs: HljsConfig | false = false,
) => {
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return shell(
    'Hono Explorer',
    `<b>Hono Explorer</b>
     <span class="meta"><span class="dot"></span> live</span>
     <span class="meta" id="count"></span>
     <span class="spacer"></span>
     <a class="btn" href="${base}/routes${q}">Routes map →</a>
     <button id="clear">Clear history</button>`,
    `<h2>Requests <span id="fnote" class="filter"></span></h2>
     <table>
       <thead><tr><th>At</th><th>Method</th><th>Path</th><th>Pattern</th><th>Status</th><th>Took</th></tr></thead>
       <tbody id="rows"></tbody>
     </table>
     <div id="detail"></div>`,
    PRELUDE(base, q) +
      `
const cls=s=>'s'+String(s).charAt(0);
const time=ts=>new Date(ts).toLocaleTimeString();
let items=[], filter=qs('route'), selected=null;

function render(){
  $('#fnote').innerHTML = filter
    ? '\u2014 only '+esc(filter)+' <button id="unfilter" style="padding:1px 6px;font-size:11px">clear</button>'
    : '';
  if($('#unfilter')) $('#unfilter').onclick=()=>{
    filter=null; history.replaceState({},'',BASE+'/'+Q); render();
  };
  const list = filter ? items.filter(t=>t.routePath===filter) : items;
  const body=$('#rows'); body.replaceChildren();
  for(const t of list){
    const tr=document.createElement('tr');
    tr.className='row'+(t._fresh?' fresh':'')+(selected===t.id?' on':'');
    tr.innerHTML='<td class="meta">'+time(t.startedAt)+'</td>'+
      '<td><span class="m '+esc(t.method)+'">'+esc(t.method)+'</span></td>'+
      '<td>'+esc(t.path)+'</td>'+
      '<td class="meta">'+esc(t.routePath||'\u2014')+'</td>'+
      '<td class="'+cls(t.status)+'">'+t.status+'</td>'+
      '<td class="meta">'+dur(t.durationMs)+'</td>';
    tr.onclick=()=>{selected=t.id;render();showDetail(t);};
    body.appendChild(tr);
  }
  if(!list.length) body.innerHTML='<tr><td colspan="6" class="empty">'+
    (filter?'No requests for this route yet.':'No requests yet \u2014 hit your API from Postman.')+'</td></tr>';
}
function add(t){
  t._fresh=true; items.unshift(t);
  if(items.length>200) items.pop();
  render(); setTimeout(()=>{t._fresh=false;render();},1200);
}

function waterfall(t){
  const spans=t.spans||[];
  if(!spans.length) return '<div class="meta">No spans \u2014 add c.var.trace.span(name, fn) in this handler.</div>';
  const total=Math.max(t.durationMs, ...spans.map(s=>s.startMs+s.durationMs)) || 1;
  const byParent={};
  for(const s of spans){ const k=s.parentId||'root'; (byParent[k]=byParent[k]||[]).push(s); }
  const rows=[];
  (function walk(pid,prefix){
    const kids=byParent[pid]||[];
    kids.forEach((s,i)=>{
      const last=i===kids.length-1;
      const branch=prefix===null?'':prefix+(last?'\u2514\u2500 ':'\u251c\u2500 ');
      const left=(s.startMs/total*100).toFixed(2);
      const width=Math.max(s.durationMs/total*100,0.4).toFixed(2);
      const extra=s.meta?' <span class="wfms">'+esc(JSON.stringify(s.meta))+'</span>':'';
      rows.push('<div class="wfrow">'+
        '<div class="wflab">'+
          (branch?'<span class="tree">'+branch+'</span>':'')+esc(s.name)+extra+
        '</div>'+
        '<div><div class="wfbar"><i style="left:'+left+'%;width:'+width+'%"></i></div>'+
        '<div class="wfms">+'+dur(s.startMs)+' \u00b7 took '+dur(s.durationMs)+'</div></div></div>');
      walk(s.id, prefix===null?'':prefix+(last?'   ':'\u2502  '));
    });
  })('root',null);
  const traced=spans.filter(s=>!s.parentId).reduce((a,s)=>a+s.durationMs,0);
  return '<div class="wf">'+rows.join('')+
    '<div class="wfms" style="margin-top:8px">total '+dur(t.durationMs)+' \u00b7 '+
    dur(traced)+' inside spans \u00b7 '+dur(Math.max(0,t.durationMs-traced))+' elsewhere</div></div>';
}

const size=o=>o?Object.keys(o).length:0;
/* undefined survives as a key name, so render it instead of dropping it */
function kvTable(obj,undef){
  const rows=Object.keys(obj).map(k=>{
    const val=undef.indexOf(k)>=0
      ? '<span class="kvu">undefined</span>'
      : code(JSON.stringify(obj[k]),'json');
    return '<div class="kvr"><span class="k">'+esc(k)+'</span><span>'+val+'</span></div>';
  }).join('');
  return '<div class="kv">'+rows+'</div>';
}
const pre=h=>h?'<pre>'+h+'</pre>':'';

/* one Set-Cookie string -> name, value, and its attributes */
function cookieRows(list){
  if(!list||!list.length) return '';
  return '<pre>'+list.map(raw=>{
    const [pair,...attrs]=String(raw).split(';');
    const i=pair.indexOf('=');
    const name=i<0?pair:pair.slice(0,i);
    const val=i<0?'':pair.slice(i+1);
    return code(name.trim()+' = '+val.trim(),'json')+
      (attrs.length?'\\n  <span class="wfms">'+esc(attrs.join(';').trim())+'</span>':'');
  }).join('\\n')+'</pre>';
}

function showDetail(t){
  const chain=(t.chain||[]).map(c=>c.method+' '+c.path+'  \u2192  '+c.handler).join('\\n')||'\u2014';

  const reqTabs=tabs([
    {label:'Headers', count:size(t.reqHeaders), html:pre(json(t.reqHeaders))},
    {label:'Cookies', count:size(t.reqCookies), html:pre(size(t.reqCookies)?json(t.reqCookies):'')},
    {label:'Query',   count:size(t.query),      html:pre(size(t.query)?json(t.query):'')},
    {label:'Params',  count:size(t.params),     html:pre(size(t.params)?json(t.params):'')},
    {label:'Body',    html:t.reqBody?pre(bodyCode(t.reqBody)):''},
  ]);

  const resTabs=tabs([
    {label:'Headers', count:size(t.resHeaders), html:pre(json(t.resHeaders))},
    {label:'Cookies', count:(t.resCookies||[]).length, html:cookieRows(t.resCookies)},
    {label:'Body',    html:t.resBody?pre(bodyCode(t.resBody)):''},
    {label:'Timing',  html:pre(code(
      'status  '+t.status+'\\n'+
      'took    '+dur(t.durationMs)+'\\n'+
      'at      '+new Date(t.startedAt).toISOString(),'json'))},
  ]);

  $('#detail').innerHTML=
    '<h2>Spans</h2>'+waterfall(t)+
    (size(t.data)?'<h2>Trace data</h2>'+kvTable(t.data,t.dataUndefined||[]):'')+
    '<h2>Matched chain</h2><pre>'+esc(chain)+'</pre>'+
    '<h2>Request</h2>'+reqTabs+
    '<h2>Response</h2>'+resTabs+
    (t.error?'<h2>Error</h2><pre>'+esc(t.error.stack||t.error.message)+'</pre>':'');

  wireTabs($('#detail'));
}

async function loadHistory(){
  items=await fetch(BASE+'/api/history'+Q).then(r=>r.json());
  render();
}
async function loadCount(){
  const r=await fetch(BASE+'/api/routes'+Q).then(r=>r.json());
  $('#count').textContent=r.router+' \u00b7 '+r.count+' routes';
}
function connect(){
  const es=new EventSource(BASE+'/api/stream'+Q);
  es.addEventListener('trace',e=>add(JSON.parse(e.data)));
  es.onerror=()=>{es.close();setTimeout(connect,2000);};
}
$('#clear').onclick=async()=>{
  await fetch(BASE+'/api/clear'+Q,{method:'POST'});
  items=[]; selected=null; $('#detail').innerHTML=''; render();
};
loadCount(); loadHistory(); connect();
`,
    hljsTags(hljs),
  );
};

/* ── page 2: routes map ────────────────────────────────────────────────── */

const routesPage = (base: string, token?: string) => {
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  return shell(
    'Routes map · Hono Explorer',
    `<b>Routes map</b>
     <span class="meta" id="stat"></span>
     <span class="spacer"></span>
     <a class="btn" href="${base}/${q}">\u2190 Requests</a>`,
    `<div class="bar">
       <div class="grow"><input id="q" placeholder="Filter by path or handler\u2026" spellcheck="false" autofocus></div>
       <span id="chips"></span>
       <button id="toggle">Collapse all</button>
     </div>
     <div id="list" class="empty">Loading\u2026</div>`,
    PRELUDE(base, q) +
      `
let all=[], term='', picked=new Set(), shut=new Set();

const group=p=>{
  const first=String(p).split('/').filter(Boolean)[0];
  return first ? '/'+first : '/';
};
const hi=(s,t)=>{
  if(!t) return esc(s);
  const i=s.toLowerCase().indexOf(t);
  if(i<0) return esc(s);
  return esc(s.slice(0,i))+'<b>'+esc(s.slice(i,i+t.length))+'</b>'+esc(s.slice(i+t.length));
};

function render(){
  const list = all.filter(r=>{
    const hit = !term || (r.path+' '+r.handler).toLowerCase().includes(term);
    const meth = picked.size===0 || picked.has(r.method);
    return hit && meth;
  });

  $('#stat').textContent = list.length===all.length
    ? all.length+' routes'
    : list.length+' of '+all.length+' routes';

  const groups=new Map();
  for(const r of list){
    const g=group(r.path);
    if(!groups.has(g)) groups.set(g,[]);
    groups.get(g).push(r);
  }

  const box=$('#list'); box.className=''; box.replaceChildren();
  if(!groups.size){ box.className='empty'; box.textContent='Nothing matches.'; return; }

  for(const [name,rows] of [...groups].sort((a,b)=>a[0].localeCompare(b[0]))){
    rows.sort((a,b)=>a.path.localeCompare(b.path)||a.method.localeCompare(b.method));
    const open = !shut.has(name) || !!term;
    const g=document.createElement('div'); g.className='grp';

    const h=document.createElement('button');
    h.className='grph';
    h.innerHTML='<span class="seg">'+(open?'\u25be':'\u25b8')+'</span> '+esc(name)+
                '<span class="n">'+rows.length+'</span>';
    h.onclick=()=>{ shut.has(name)?shut.delete(name):shut.add(name); render(); };
    g.appendChild(h);

    if(open){
      const b=document.createElement('div'); b.className='grpb';
      for(const r of rows){
        const row=document.createElement('button');
        row.className='rt';
        row.innerHTML='<span class="m '+esc(r.method)+'">'+esc(r.method)+'</span>'+
                      '<span class="p">'+hi(r.path,term)+'</span>'+
                      '<span class="h">'+hi(r.handler,term)+'</span>';
        row.title='See requests for '+r.path;
        row.onclick=()=>{
          location.href = BASE+'/'+(Q?Q+'&':'?')+'route='+encodeURIComponent(r.path);
        };
        b.appendChild(row);
      }
      g.appendChild(b);
    }
    box.appendChild(g);
  }
}

function chips(){
  const box=$('#chips'); box.replaceChildren();
  for(const m of [...new Set(all.map(r=>r.method))].sort()){
    const b=document.createElement('button');
    b.textContent=m; b.style.marginRight='4px';
    b.onclick=()=>{ picked.has(m)?picked.delete(m):picked.add(m);
                    b.classList.toggle('on'); render(); };
    box.appendChild(b);
  }
}

$('#q').oninput=e=>{ term=e.target.value.trim().toLowerCase(); render(); };
$('#toggle').onclick=()=>{
  const names=new Set(all.map(r=>group(r.path)));
  if(shut.size) shut.clear(); else names.forEach(n=>shut.add(n));
  $('#toggle').textContent = shut.size ? 'Expand all' : 'Collapse all';
  render();
};

fetch(BASE+'/api/routes'+Q).then(r=>r.json()).then(r=>{
  all=r.routes;
  document.title='Routes map ('+r.count+') \u00b7 Hono Explorer';
  chips(); render();
});
`,
  );
};
