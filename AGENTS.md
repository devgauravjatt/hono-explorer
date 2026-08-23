# AGENTS.md

You are an expert in JavaScript, Rspack, Rsbuild, Rslib, and library development. You write maintainable, performant, and accessible code.

## Commands

- `pnpm run build` - Build the library for production
- `pnpm run dev` - Turn on watch mode, watch for changes and rebuild the library
- `pnpm run test` - Run tests
- `pnpm run test:watch` - Run tests in watch mode

## Docs

- Rslib: https://rslib.rs/llms.txt
- Rsbuild: https://rsbuild.rs/llms.txt
- Rspack: https://rspack.rs/llms.txt
- Rstest: https://rstest.rs/llms.txt

## Tools

### Biome

- Run `pnpm run lint` to lint your code
- Run `pnpm run format` to format your code

# AGENTS.md

Instructions for AI coding agents working in this repository.

## What this is

`hono-explorer` is a single-file devtool middleware for Hono. It serves two
HTML pages from inside the user's own app: a live request list and a routes
map. It has **zero runtime dependencies** — Hono is a peer dependency.

## Layout

```
src/index.ts        the entire package — server logic AND both UI pages
scripts/            local checks, not published
dist/               build output, gitignored
```

There is one source file on purpose. Do not split it into modules without
being asked; the single-file shape is what makes it droppable into any project.

## Commands

```bash
npm run typecheck    # tsc --noEmit, no tsconfig needed
npm run check:ui     # extracts the inline <script> from both pages, node --check
npm test             # both of the above
npm run build        # emits dist/index.js + index.d.ts
```

`npm run build` uses CLI flags rather than a `tsconfig.json`. Keep it that way
unless the flag list outgrows one line.

## The escaping trap — read this before touching the UI

The browser-side JavaScript lives inside a **TypeScript template literal**.
That means every escape sequence is processed twice: once by TypeScript when
the template literal is evaluated, once by the browser when it parses the
emitted `<script>`.

A single backslash gets consumed by TypeScript and never reaches the browser:

```ts
// WRONG — TS turns \n into a real newline, so the emitted JS is:
//   }).join('
//   ')
`  }).join('\n')  `
// RIGHT — TS turns \\n into \n, the browser sees a proper escape
`  }).join('\\n')  `;
```

The same applies to `\\u2192`, `\\u2514`, and any other escape inside the
client script. Symptom: `SyntaxError: Invalid or unexpected token` in the
browser console, pointing at a line that looks perfectly fine in the source.

**Always run `npm run check:ui` after editing anything inside the template
literals.** It parses the emitted script with `node --check` and catches this
class of bug, which typechecking cannot see.

Related: avoid backticks in the client script entirely — they would terminate
the enclosing TypeScript template literal. Use string concatenation.

## Conventions

- **Client script is vanilla JS.** No build step, no framework, no bundler for
  the UI. String concatenation, `document.createElement`, plain event handlers.
- **Escape everything user-controlled** with the `esc()` helper before it goes
  into `innerHTML`. Header values, paths, and bodies all come from requests.
- **Degrade gracefully.** highlight.js may fail to load; every call site is
  guarded by `window.hljs &&`. Keep new integrations equally optional.
- **Theming uses CSS variables** declared in `CSS`. Don't hardcode colours;
  add a variable if you need a new one.
- **Comments explain _why_, not _what_.** The codebase is deliberately light on
  comments — add one only where the reason isn't obvious from the code.

## Things that are the way they are on purpose

- **No `AsyncLocalStorage`.** Spans hang off `c.var.trace` and nest via an
  explicit stack. This keeps the package working on Cloudflare Workers without
  a compat flag. Don't add ALS without discussing it.
- **No automatic middleware timing.** An earlier version wrapped every handler
  via a Proxy on the app; it was removed in favour of explicit
  `c.var.trace.span()`. Don't reintroduce it.
- **No `fetch` monkey-patching.** The README shows a `tracedFetch` helper
  instead. Global patching is a footgun in a shared process.
- **Cookies are never masked**, only headers matching the `redact` regex.
- **The routes map is a flat list grouped by first segment**, not a nested
  tree. Deep trees needed too many clicks at a few hundred routes.

## Adding a feature

1. Server-side capture goes in `tracer()`, and the new field goes on the
   `Trace` type.
2. `JSON.stringify` drops `undefined` — if the field can be undefined, handle
   it explicitly (see how `dataUndefined` is built).
3. Render it in `showDetail()`, ideally as another tab rather than a new
   top-level `<h2>`.
4. Run `npm test`.
5. Update the options table in `README.md` if you added an option.

## Verifying by hand

Prefer in-process requests over spinning up a server — `app.request()` is
enough for almost everything:

```ts
const app = new Hono<ExplorerEnv>();
app.use("*", explorer.tracer());
app.route("/__explorer", explorer.ui(app));

await app.request("/api/whatever");
const traces = await (await app.request("/__explorer/api/history")).json();
```

## Do not

- Add runtime dependencies.
- Add a bundler or a CSS framework.
- Persist traces to disk or a database inside this package. `explorer.store`
  is exposed so users can do that themselves.
- Change `basePath` defaults or endpoint paths — they're a public contract.
