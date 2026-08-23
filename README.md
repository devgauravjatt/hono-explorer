# hono-explorer

A devtool that lives inside your Hono app. Mount it on a route, open it in a
browser, and watch requests arrive in real time — with a routes map, full
request/response detail, and a span waterfall you build yourself.

No dependencies beyond Hono. Nothing to run alongside your server.

```
GET /api/users/42  200  307.79ms  pattern=/api/users/:id

  outer                    +1.88ms  · took 30.19ms
  ├─ inner-1               +1.93ms  · took 19.61ms
  └─ inner-2               +21.58ms · took 10.49ms
     ├─ leaf-a             +21.61ms · took 5.19ms
     └─ leaf-b             +26.82ms · took 5.24ms
  db:session               +32.08ms · took 15.21ms
```

## Install

```bash
pnpm add -D hono-explorer
# or npm i -D hono-explorer
# or bun add -d hono-explorer
```

`hono >= 4.0.0` is a peer dependency.

## Quick start

Keep your setup clean and organized by defining your explorer instance and types in a separate `explorer.ts` file, then importing it into your main server file.

### 1. Configure Explorer (`explorer.ts`)

```ts
import { createExplorer, type TraceCtx } from "hono-explorer";

export const explorer = createExplorer({
  basePath: "/__explorer",
  max: 200,
});

export type Env = {
  Variables: {
    trace: TraceCtx;
    userId?: string;
  };
};
```

> **Note:** If you don't need custom variables, you can alternatively use `Hono<ExplorerEnv>` using `type { ExplorerEnv } from "hono-explorer"`.

### 2. Mount in your Hono App (`index.ts`)

```ts
import { Hono } from "hono";
import { explorer, type Env } from "./explorer";

const app = new Hono<Env>();

// 1. Must be the first middleware registered
app.use("*", explorer.tracer());

// Your application routes
app.get("/api/users/:id", getUser);

// 2. Mount the explorer UI (typically for development only)
if (process.env.NODE_ENV !== "production") {
  app.route("/__explorer", explorer.ui(app));
}

export default app;
```

Open `http://localhost:3000/__explorer`.

Two things matter here:

- **`tracer()` goes first.** It creates the trace and puts it on the context.
  Anything registered above it runs outside the trace and won't be recorded.
- **`ui(app)` needs the same app instance** you registered your routes on —
  that's how it reads `app.routes` to build the routes map.

## Spans

Timing is opt-in and explicit. Name the thing, hand it a function, and the
duration is measured for you.

```ts
const user = await c.var.trace.span("db:findUser", () => db.find(id));
```

### `span(name, fn, meta?)`

Returns whatever `fn` returns. Works with sync functions too (you still get a
promise back). Nesting a span inside another span makes it a child.

```ts
await c.var.trace.span("checkout", async () => {
  await c.var.trace.span("db:cart", loadCart); // child of checkout
  await c.var.trace.span("stripe:charge", charge); // child of checkout
});
```

If `fn` throws, the span still closes, the message lands in `meta.error`, and
the error is rethrown — your `try/catch` behaves normally.

### `span(name)` — handle form

For when start and end aren't in the same expression. Call `end()` in a
`finally` so a throw can't leave the span open.

```ts
const s = c.var.trace.span("cache");
try {
  const hit = await redis.get(key);
  s.end({ hit: !!hit });
} finally {
  s.end(); // no-op if already ended
}
```

### `annotate(meta)`

Attaches data to the innermost open span — for facts you only learn partway
through.

```ts
await c.var.trace.span("fetch:billing", async () => {
  const res = await fetch(url);
  c.var.trace.annotate({ status: res.status });
  return res;
});
```

### `set(key, value)` / `trace.data`

A bag on the trace itself, not tied to any span. Chainable.

```ts
c.var.trace.set("userId", user.id).set("tenant", tenant);
c.var.trace.data.apiKey = c.req.header("x-api-key"); // direct assignment works
```

`undefined` values survive: `JSON.stringify` would drop the key entirely, so
the explorer tracks those names separately and shows `undefined` in the panel
— distinct from `null`.

### Concurrency caveat

Spans nest by call order, so `Promise.all` mis-parents them:

```ts
await Promise.all([
  c.var.trace.span("a", fa),
  c.var.trace.span("b", fb), // shows up as a child of 'a'
]);
```

Durations are still correct — only the tree shape is wrong. Wrap them if the
shape matters:

```ts
await c.var.trace.span("parallel", () => Promise.all([fa(), fb()]));
```

## Tracing outbound fetch

There's no automatic `fetch` patching. Wrap it once and pass the trace:

```ts
export async function tracedFetch(trace: TraceCtx, url: string, init?: RequestInit) {
  return trace.span("fetch " + new URL(url).host, async () => {
    const res = await fetch(url, init);
    trace.annotate({ status: res.status, path: new URL(url).pathname });
    return res;
  });
}
```

Service functions then take `trace` instead of the whole context:

```ts
await getInvoice(c.var.trace, id);
```

## The UI

**`/__explorer`** — live request list. Click a row for the span waterfall,
matched middleware chain, and tabbed Request (Headers · Cookies · Query ·
Params · Body) and Response (Headers · Cookies · Body · Timing) panels. New
requests stream in over SSE.

**`/__explorer/routes`** — every registered route, grouped by first path
segment, with search across paths and handler names, method filters, and
collapse-all. Clicking a route jumps back to the request list filtered to it.

Durations under a second read as `ms`; past that they switch to `s`.

## Options

### `createExplorer(options)`

| Option         | Default                       | What it does                                                                            |
| -------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `basePath`     | `'/__explorer'`               | Where the UI is mounted. Requests to it are never traced.                               |
| `max`          | `200`                         | Ring-buffer size. Older traces fall off the end.                                        |
| `captureBody`  | `true`                        | Record request/response bodies. Costs one `clone()` per request.                        |
| `maxBodyBytes` | `32000`                       | Bodies larger than this are skipped.                                                    |
| `ignore`       | `[]`                          | Extra path prefixes to skip, on top of `NOISE`.                                         |
| `ignoreNoise`  | `true`                        | Skip browser-generated requests — Chrome DevTools' workspace probe and `/favicon.ico`.  |
| `redact`       | `/authorization\|x-api-key/i` | Header names whose value is masked. `false` shows everything. Cookies are never masked. |
| `token`        | —                             | If set, every explorer endpoint requires `?token=…`.                                    |

### `explorer.ui(app, uiOptions)`

| Option         | Default           | What it does                                                                                                     |
| -------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `selfRoutes`   | `false`           | Include the explorer's own routes in the routes map. Off by default so the count reflects your app.              |
| `highlight`    | `'atom-one-dark'` | highlight.js theme name from cdnjs. `false` disables highlighting entirely.                                      |
| `highlightCdn` | cdnjs             | Serve highlight.js from elsewhere — a self-hosted copy for offline work. SRI is only applied to the default CDN. |

highlight.js loads from cdnjs with a verified integrity hash. If it fails to
load, the panel still renders — just without colours.

## HTTP endpoints

Everything the UI uses is plain JSON, so `curl` works too.

| Endpoint                        | Returns                                      |
| ------------------------------- | -------------------------------------------- |
| `GET {base}/`                   | Request list page                            |
| `GET {base}/routes`             | Routes map page                              |
| `GET {base}/api/routes`         | `{ router, count, hidden, routes[] }`        |
| `GET {base}/api/history?limit=` | Traces, newest first                         |
| `GET {base}/api/history/:id`    | One trace                                    |
| `GET {base}/api/stream`         | SSE, one `trace` event per completed request |
| `POST {base}/api/clear`         | Empty the buffer                             |

```bash
curl -s localhost:3000/__explorer/api/history \
  | jq -r '.[0] | "\(.method) \(.path) \(.durationMs)ms",
      (.spans[] | "  \(.name)  \(.durationMs)ms")'
```

## Production

Traces live in memory, in one process. That has two consequences:

- **Don't mount it in production.** Guard with `NODE_ENV`, or use `token`.
- **Serverless won't hold history.** On Cloudflare Workers or Lambda each
  request may land in a fresh isolate, so the buffer reads empty. It works as
  intended on a long-lived Node, Bun, or Deno process.

`explorer.store` is exposed if you want to push traces somewhere durable
yourself.

## License

MIT
