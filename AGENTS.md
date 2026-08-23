# AGENTS.md

Instructions for AI coding agents working in this repository.

You are an expert in JavaScript, TypeScript, Rspack, Rsbuild, Rslib, Hono, and library development. You write maintainable, performant, and type-safe code.

## What this is

`hono-explorer` is a lightweight devtool middleware for Hono. It serves two HTML pages from inside the user's own app: a live request list and a routes map. It has **zero runtime dependencies** — `hono` is a peer dependency (`>= 4.0.0`).

## Layout

```
src/
  index.ts          package entry point (re-exports from hono-explorer)
  hono-explorer.ts  server logic, tracing middleware, and embedded UI pages
tests/
  auth.ts           sample auth middleware for dev/testing
  explorer.ts       explorer instance configuration for tests
  index.ts          sample server for local development
  index.test.ts     unit tests using rstest
dist/               build output (bundle + declarations), gitignored
```

## Commands

- `pnpm run build` - Build the library and TypeScript declarations using Rslib
- `pnpm run dev` - Start local development server with watch mode (`nub watch tests/index.ts`)
- `pnpm run test` - Run tests using `rstest`
- `pnpm run test:watch` - Run tests in watch mode
- `pnpm run check` - Run Biome linter and formatter with auto-fix (`biome check --write`)
- `pnpm run lint` - Run Biome linter with auto-fix (`biome lint --write`)
- `pnpm run format` - Format code with Biome (`biome format --write`)

## Docs

- Rslib: https://rslib.rs/llms.txt
- Rsbuild: https://rsbuild.rs/llms.txt
- Rspack: https://rspack.rs/llms.txt
- Rstest: https://rstest.rs/llms.txt

## The escaping trap — read this before touching the UI

The browser-side JavaScript lives inside a **TypeScript template literal**.
That means every escape sequence is processed twice: once by TypeScript when the template literal is evaluated, once by the browser when it parses the emitted `<script>`.

A single backslash gets consumed by TypeScript and never reaches the browser:

```ts
// WRONG — TS turns \n into a real newline, so the emitted JS is broken:
//   }).join('
//   ')
`  }).join('\n')  `

// RIGHT — TS turns \\n into \n, the browser sees a proper escape:
`  }).join('\\n')  `;
```

The same applies to `\\u2192`, `\\u2514`, and any other escape inside the client script. Symptom: `SyntaxError: Invalid or unexpected token` in the browser console.

Related: avoid backticks in the client script entirely — they would terminate the enclosing TypeScript template literal. Use string concatenation.

## Conventions

- **Client script is vanilla JS.** No build step, no framework, no bundler for the UI. String concatenation, `document.createElement`, plain event handlers.
- **Escape everything user-controlled** with the `esc()` helper before it goes into `innerHTML`. Header values, paths, and bodies all come from requests.
- **Degrade gracefully.** highlight.js may fail to load; every call site is guarded by `window.hljs &&`. Keep new integrations equally optional.
- **Theming uses CSS variables** declared in `CSS`. Don't hardcode colours; add a variable if you need a new one.
- **Comments explain _why_, not _what_.** The codebase is deliberately light on comments — add one only where the reason isn't obvious from the code.

## Architectural Constraints

- **Zero runtime dependencies.** `hono` is a peer dependency. Never add runtime dependencies.
- **No `AsyncLocalStorage`.** Spans hang off `c.var.trace` and nest via an explicit stack. This keeps the package working on Cloudflare Workers without a compat flag.
- **No automatic middleware timing.** Timing uses explicit `c.var.trace.span()`.
- **No `fetch` monkey-patching.** The README shows a `tracedFetch` helper instead.
- **Cookies are never masked**, only headers matching the `redact` regex.
- **The routes map is a flat list grouped by first segment**, not a nested tree.

## Adding a feature

1. Server-side capture goes in `tracer()`, and the new field goes on the `Trace` type.
2. `JSON.stringify` drops `undefined` — if the field can be undefined, handle it explicitly (see how `dataUndefined` is built).
3. Render it in `showDetail()`, ideally as another tab rather than a new top-level `<h2>`.
4. Run `pnpm run test` and `pnpm run check`.
5. Update the options table in `README.md` if you added an option.

## Verifying by hand

Prefer in-process requests over spinning up a server — `app.request()` is enough for almost everything:

```ts
const app = new Hono<ExplorerEnv>();
app.use("*", explorer.tracer());
app.route("/__explorer", explorer.ui(app));

await app.request("/api/whatever");
const traces = await (await app.request("/__explorer/api/history")).json();
```

