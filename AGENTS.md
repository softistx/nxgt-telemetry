# AGENTS.md

Instructions for any coding agent working in `nxgt-telemetry`.

## What this repository is

The `@nxgt/*` packages for observability, published to the public npm registry:

| package | what it is |
| --- | --- |
| `@nxgt/telemetry` | the core. `createTelemetry(service, options)`, `span`, `continuing`, `createLogger`, `event`, `Sampler`, `Exporter`, and the pipeline behind them. W3C `traceparent` in and out. **No runtime dependency at all** |
| `@nxgt/telemetry-otlp` | `otlpExporter`: OTLP/HTTP, JSON, over `fetch`, with retry, gzip and partial-success handling |
| `@nxgt/telemetry-hono` | `telemetry()`: a Hono middleware that wraps the handler in one server span |
| `@nxgt/telemetry-httpyz` | a `@nxgt/httpyz` middleware: one client span per call, `traceparent` injected |
| `@nxgt/telemetry-mongo` | `mongoExporter` (signals behind a TTL index) and `instrumentMongo` (spans from the driver's command monitoring) |
| `@nxgt/telemetry-logging` | the winston bridge, both directions, never both at once |

It was started on 2026-09-15, on the tooling of `softistx/nxgt-data`, which took
it from `softistx/nxgt-http`: the same build, artifact check, publish script, CI
and conventions. When one of them changes there for a reason that applies here,
change it here too.

**It is the TypeScript counterpart of `stx-telemetry`**, the Kotlin library in
`softistx/nxgt-krepo` (`libs/observability/stx-telemetry`, with its `-otlp`,
`-ktor`, `-mongo`, `-slf4j` and `-spring` modules). The vocabulary is
deliberately the same on both estates: the same four severities, the same span
kinds and statuses, the same `traceparent` rules, the same sampling rule, the
same semantic attribute names, the same OTLP mapping. **When you change one of
those here, the two have diverged** — say so in the changeset, and open the
matching change there. What is *not* shared is anything that follows from the
runtime; the table in "What differs from the Kotlin" says what and why.

## The five decisions

Everything else follows from these. They are the library's reason to exist, and
a change that quietly breaks one is a bug even when the suite is green. The
`code-reviewer` agent checks each of them.

### 1. The current span lives in the AsyncLocalStorage, never in a global

`node:async_hooks`'s `AsyncLocalStorage` propagates through `await`, through
timers, through promise chains — into everything started inside a `span()`, out
of nothing, and it is readable **synchronously**. A module-level `let current`
would look right in development and start attributing one request's spans to
another under concurrency: a bug with no stack trace and no failing test, in the
tool meant to make such bugs visible.

The Kotlin library makes this argument against SLF4J's `ThreadLocal` MDC and
pays for it with a `ThreadContextElement`. In TypeScript the two halves come for
free, and the synchronous read is what lets `log.info()` stay a plain function —
a log written from a constructor, from a `catch` in ordinary code, or from a
callback still has to come out, and an async logger cannot be called from any of
them.

There is one module-level fallback, in `src/context/`, for a runtime with no
`node:async_hooks`. It is the browser path, where there is one request, and it
is the only place such a variable is allowed.

### 2. There is no OpenTelemetry SDK here

`@nxgt/telemetry-otlp` speaks OTLP/HTTP itself: it is a JSON document and a
`fetch`. **No manifest in this repository may depend on `@opentelemetry/*`.**
The SDK would bring a context implementation this library exists to not have,
a dependency tree to hold it, and — under Bun — auto-instrumentation that
monkey-patches module loading and is not reliable there. Our Mongo spans come
from the driver's *public* command-monitoring events for the same reason.

OTLP is a wire format. Any collector that reads it reads us.

### 3. Writing a signal never waits and never fails

`log.*`, `SpanScope.attribute`, `SpanScope.event` and `Pipeline.post` are
synchronous, total functions. They push onto an unbounded buffer that one
consumer drains; a bounded queue would answer back-pressure by dropping signals
or by blocking the application, and neither is an answer. The consequences are
deliberate:

- **no telemetry installed** — the log is dropped in silence. A library that
  logs must work inside an application that has never heard of this one;
- **an exporter throws** — it goes to `onExportError`, and the next exporter
  still gets the batch. A collector being down is not a reason for a request to
  fail;
- **an event will not validate** — it is logged with the fields that could be
  read, never not at all.

A path from any of those four that can throw or `await` is a defect.

### 4. Sampling is decided once, by the root

The sampler is asked when a **root** span is created. The answer travels down
every child and out over the wire in the `traceparent`. A sampler consulted per
span produces traces missing their middles, and a gap in a trace looks like work
that never happened.

The decision is a function of the trace id, not a coin toss: `ratioSampler(0.1)`
in two services makes the **same** decision about the same trace. Two services
tossing independently at 10% keep a whole trace 1% of the time. The rule is the
OTel one — the low 64 bits of the trace id against `ratio × 2⁶⁴` — so we agree
with anything else that implements it.

**Logs are never sampled.** A log dropped because its trace was not kept is a
log missing at precisely the moment somebody is reading logs to find out what
happened. The `traceId` is attached either way, so an unsampled trace's logs
still group.

### 5. `close()` is asynchronous, and cannot be anything else

This is the one place the Kotlin library has something we cannot have. There,
`close()` blocks: a shutdown hook cannot suspend, and a close that returned
before the backlog shipped would lose exactly the signals a shutdown most needs
to explain itself. JavaScript has no way to block the event loop, so `close()`
returns a promise, races the drain against `drainTimeout`, and the application
has to `await` it — from a `SIGTERM`/`SIGINT` handler, or through
`await using`. A process that exits without awaiting it loses its last batch,
and the READMEs say so.

## Layering

```
@nxgt/telemetry            (no internal dependency, no runtime dependency)
   ├─ @nxgt/telemetry-otlp
   ├─ @nxgt/telemetry-hono
   ├─ @nxgt/telemetry-httpyz
   ├─ @nxgt/telemetry-mongo
   └─ @nxgt/telemetry-logging
```

**There are no cycles and there must not be one.** An integration depends on the
core by `workspace:^` and imports it by its published name; there is no tsconfig
`paths` to it and no relative import into it. **One integration never imports
another**, and that — not "never share code" — is what the duplication table is
about: something two integrations both need may move into the core when it is
genuinely a telemetry concern, and is otherwise kept twice with a row in that
table saying so.

**The core is a `dependencies` of each integration, not a peer, and that is
deliberate.** A required peer would be the stricter guarantee — one copy, and
therefore one `AsyncLocalStorage` — but `verify:artifacts` refuses a required
peer on a package that is on no registry, which is exactly where
`@nxgt/telemetry` is until the first release. `workspace:^` publishes as
`^0.1.0`, so a consumer on any overlapping range resolves to one copy anyway.
The residual risk is real and worth knowing: a consumer who pins
`@nxgt/telemetry` to a range that stops overlapping gets **two** copies, two
storages, and `currentSpan()` answering `undefined` inside a span — with no
error message, because nothing is wrong at the type level. Revisit this once
the core is published: a required peer is then allowed, and it is the better
answer.

- **The core's `dependencies` is empty and stays empty**, and so is its
  `devDependencies` apart from `@types/bun`. [Standard
  Schema](https://standardschema.dev) is a contract of types with no runtime, so
  it is **declared in the source** (`src/logger/standard-schema.ts`), the way
  `@nxgt/httpyz` declares it, rather than depended on. Anything that would need a
  real dependency is an integration package, not the core.
- **An integration's host is an *optional* peer** — `hono`, `@nxgt/httpyz`,
  `mongodb`, `winston` — pinned exactly as a devDependency so the specs run
  against a known version. A **required** peer on a package a consumer did not
  ask for fails their install; `verify:artifacts` rejects a required peer that is
  on no registry at all.
- **Another collector or another host is another package.** Do not grow
  `@nxgt/telemetry-otlp` a second protocol.
- Metrics are not here yet. They belong on this pipeline as a third `Signal`
  variant, and nothing in the model or in the `Exporter` contract has to change
  to admit them — which is why the discriminator is the field `type`, with the
  values `"log"` and `"span"`, and not a class name.

## What differs from the Kotlin, and why

Copy the Kotlin's *decisions*; do not copy its mechanisms. These five are the
only places the two are allowed to diverge, and each one has a reason in the
runtime.

| `stx-telemetry` | here | because |
| --- | --- | --- |
| `CoroutineContext.Element` plus a `ThreadContextElement` mirror | `AsyncLocalStorage` | it is both halves at once; see decision 1 |
| `runBlocking` inside `close()` | `async close()` racing `drainTimeout` | nothing can block the event loop; see decision 5 |
| `Channel(UNLIMITED)` and a consumer coroutine | an array and one `.unref()`ed timer | JavaScript is single-threaded, so "no synchronisation, batch order is write order" is free. **`.unref()` matters**: a live timer keeps the process alive |
| `CancellationException` → `SpanStatus.Cancelled` | an `isAbort` predicate over `AbortError` | there is no coroutine cancellation; `Cancelled` is rare here |
| `@Serializable` + `@SerialName` for a typed event | `event(name, schema)` over Standard Schema | see below |

**The typed event is the one that needs care.** The Kotlin argument is that
declaring what you log makes *choosing what is logged the same act as writing the
code*, rather than a redaction list somebody has to keep up to date — a
`toString()` of a domain object logs the field added next quarter, card number
included, and nobody finds out, because a log that says too much still looks
like a working log.

`event('checkout.charged', schema)` keeps that: it validates through Standard
Schema and emits **the validated value**, so an object schema's unknown keys are
gone. Zod, valibot and arktype all satisfy it and none of them is a dependency
here. When validation fails, or returns a promise, the call still logs — with
the readable scalar fields and `telemetry.event.invalid` set — because of
decision 3.

## The vocabulary, which is shared and not up for local change

- **Four severities**: `debug` 5, `info` 9, `warn` 13, `error` 17. There is no
  `trace` level; sub-debug detail is an attribute on a span.
- **Span kinds**: `internal` 1, `server` 2, `client` 3, `producer` 4,
  `consumer` 5. **Statuses**: `ok`, `error`, `cancelled`.
- **`traceparent`**: rendered `00-<32 hex>-<16 hex>-<01|00>`. Parsing **returns
  null, never throws**, on fewer than four parts, a version that is not two
  characters, version `ff`, an id that is the wrong length or all zeros or not
  lowercase hex, or flags that are not hex. Later versions are accepted and
  their extra fields ignored. There is no `tracestate`.
- **An attribute is a scalar**, or a list of scalars — that is what a backend
  can index, filter and group by, and what OTLP accepts. Anything with structure
  is an event type. The coercion never refuses a value; its last resort is
  `String(value)`, because a log call must not fail.
- **Attributes are inherited**: those given to `span()` and `withAttributes()`
  reach the logs and spans nested inside. `scope.attribute()` is that span only.
  Merging is left-then-right, and the right wins.
- **Semantic names**: `service.name`, `service.version`,
  `deployment.environment.name`; `http.request.method`, `url.path`,
  `http.route`, `http.response.status_code`; `exception.type`,
  `exception.message`, `exception.stacktrace`. A server span is named
  `"<METHOD> <route template>"`, and the template is only known **after**
  routing, so the span is renamed then.
- **Defaults**: `batch` 512, `linger` 1 s, `drainTimeout` 10 s, `minimum`
  `info`, `stackTraces` true, sampler `alwaysSample`.
- **Ids come from `crypto.getRandomValues`**, never `Math.random()`.

## The build

Every package is built by the root `build.ts`, as `bun run ../../build.ts`:

- **JavaScript**, from `Bun.build` with `packages: 'external'` and
  `splitting: true`. A library never bundles its dependencies, and splitting puts
  what two entry points share in a chunk both import — without it a subpath
  would carry its own copy of an error class, which an `instanceof` against the
  one from the root export rejects.
- **Declarations**, from `tsc --emitDeclarationOnly` against
  `tsconfig.build.json`, which excludes `*.spec.ts` and `test/`.

Entry points are declared under `nxgt.entrypoints`, and each one needs a matching
key in `exports`.

- **`export * from '<external package>'` only in an entry point.** Below one,
  Bun emits a re-export of an undeclared variable, and the built file throws at
  import while `bun run build` exits 0.
- **A build that exits 0 is not evidence the artifact loads.**
  `bun run verify:artifacts` packs every package, installs the tarballs as a
  consumer does, imports every subpath in `exports`, and rejects a manifest that
  would break an install: a `link:` or `file:` in a field a consumer resolves, a
  **required** peer on no registry, an exact pin on a sibling, or a package that
  is not MIT or ships no `LICENSE`. `changeset:publish` runs it, so a release
  cannot skip it.
- **Build before typecheck and tests.** Every package's `exports` points at
  `./dist/*`, so on a clean checkout an integration resolves the core to nothing
  and typecheck reports a wall of phantom TS2307. CI builds first.
- **An inferred return type whose type lives in a nested `node_modules` path
  cannot be named** in the emitted `.d.ts` (TS2883). Annotate it explicitly,
  through a type the consumer can resolve.

## Tests

- **Specs are `*.spec.ts`, next to the code they test**, run by `bun test src`.
- **Type tests are `test/types/*.ts`**, checked by the package's `typecheck` and
  never run. A call that must not compile carries `// @ts-expect-error`; if it
  compiles, tsc fails on the unused directive. A public function that can refuse
  an argument needs one.
- **`@nxgt/telemetry-mongo`'s specs run against a real mongod**, started by
  `mongodb-memory-server-core`, version pinned in `test/server.ts` and the
  binary cached by CI in `.cache/mongodb`. Retention is a TTL index, and nothing
  fake answers how Mongo refuses to redefine an index with different options.
- **The invariants above are what the specs are for.** The ones that a green
  build does not give you, and that must each have a spec:
  a span surviving many `await`s; two sibling tasks that cannot see each other's
  span; the absence of a context outside any span; every `traceparent` rejection
  rule, one case each; a sampling decision taken at the root and inherited down
  and over the wire; a log of an unsampled trace still coming out, with its
  `traceId`; a flush at `batch`, a flush at `linger`, and order preserved; an
  exporter that throws not stopping the others; `post()` after `close()` not
  throwing; `close()` returning within `drainTimeout` against an exporter that
  never answers; an exception rethrown with the span marked `error`.
- **A propagation change needs a spec that asserts on the second span's
  `parentSpanId`.** Round-tripping a header is not evidence the chain links.

## Releasing

Changesets, with independent versions. `bun changeset` describes a change.
Merging to `develop` opens a "Version packages" PR, and merging that PR
publishes to npm.

- **A change under `packages/` needs a changeset.** CI runs `changeset:status`,
  except on `changeset-release/develop`.
- **`bun publish`, not `changeset publish`.** `scripts/publish.ts` publishes in
  dependency order and skips versions already on the registry. It writes the
  `git-tag` events `changesets/action@v2` reads from `$CHANGESETS_OUTPUT`.
- **Registry configuration lives in `bunfig.toml`, never in `.npmrc`.**
  Installing needs no token. Publishing reads `$NPM_TOKEN`, which must be a
  **granular** access token covering the `@nxgt` scope, not selected packages —
  on a first release none of these names exists yet, so "only select packages"
  issues a token covering nothing and every publish 404s in a way that reads
  like a missing package. The only test of whether a token can publish is a
  publish.
- **The release PR needs the repository's switch.** Settings → Actions →
  General → Workflow permissions: *Read and write*, plus *Allow GitHub Actions
  to create and approve pull requests*. The organisation setting does not
  propagate. To check it:
  `gh api /repos/softistx/nxgt-telemetry/actions/permissions/workflow`.
- **Siblings are depended on by `workspace:^`, never `workspace:*`**, which
  publishes as an exact version and gives a consumer two copies of the core —
  and two copies means two `AsyncLocalStorage` instances, so the second one's
  spans have no parent.
- **`typescript` is a peer, `^6.0.3`, in every package**, as in nxgt-core,
  nxgt-http and nxgt-data; do not raise it in one package alone.
- **Every package is public**, like the repository. Never `private: true`.
- **Every package is MIT**, with `LICENSE` in its `files` and a copy of the root
  `LICENSE` in its directory. A new package copies it.

## Deliberate duplication: do not "clean this up"

| Kept twice | Why |
| --- | --- |
| `LICENSE`, at the root and in each `packages/*/` | npm ships only the `LICENSE` in the package's own directory. `verify:artifacts` fails a tarball without one. Change them all together |
| `build.ts`, `scripts/`, `.github/`, `biome.json`, `bunfig.toml`, `tsconfig.base.json` | copied from nxgt-data, not shared: each repository releases on its own. Change both when the reason applies to both |
| the span-shaped fields an integration builds (`http.request.method`, `url.path`, status mapping) in `-hono` and `-httpyz` | one is a server span and the other a client span, and they disagree where it matters: a client call fails at **400**, a server request at **500**. A shared builder would make each depend on the other's host. **A name they both set must mean the same thing** — `server.address` is the host without its port on both sides, and `server.port` carries it — because a server span and the client span that called it end up on the same dashboard |
| `SERVER_ADDRESS` and `SERVER_PORT` declared again in `-mongo/src/attributes/db.ts` | it is the same name and the same meaning — the host without its port, and the port beside it — but the constant is three lines and the alternative is `-mongo` importing `-httpyz`, which is the rule above. One integration never imports another. **The meaning is what must stay in step, not the declaration** |
| the `guarded` hook wrapper, and `always`/`nothing`, in `-hono` and `-httpyz` | twelve lines that touch neither host. Each integration stays installable on its own, and the core has no hooks to justify owning it. Change both when the reason applies to both |

## Conventions

- Biome, with tabs and single quotes. Run `./node_modules/.bin/biome check
  --write` before committing, and `biome ci` must pass.
- Commit messages: `<type>: <Capitalized summary>`, with types `feat`, `fix`,
  `update`, `chore`, `docs`, `refactor`, `tests` and `typo`.
- Git: the default branch is `develop`. Work on a feature branch and open a
  pull request into `develop`.
- A repository script is a TypeScript file run by Bun, with Bun Shell, not a
  `.sh`.
- **Imports carry no extension**: `from './pipeline'`, not `'./pipeline.js'`.
- **Files are organised in folders by role**, never flat under `src/`:
  `model/`, `attributes/`, `trace/`, `context/`, `telemetry/`, `span/`,
  `logger/`, `export/`. Only `src/index.ts` and declared entry points sit at the
  top.
- **A long file of declarations is fine; a long function is not.** A function
  past **80 lines** is the signal; keep a source file under **250**.
- **A package's `README.md` is its page on npmjs.** It is read by someone who
  has never seen this repository: organise it by section, with a copy-paste
  example each, an **API** section and a **Traps** section, and never name a
  private application or a private monorepo.

## Known state

`bun run test` is **466 pass, 0 fail**: `@nxgt/telemetry` 238,
`@nxgt/telemetry-otlp` 72, `@nxgt/telemetry-hono` 44,
`@nxgt/telemetry-httpyz` 40, `@nxgt/telemetry-mongo` 67, scripts 5. It runs one
process per package, then the scripts' specs. Treat any failure as yours.

`@nxgt/telemetry-mongo`'s specs run against a **real mongod**, downloaded once by
`mongodb-memory-server-core` into `.cache/mongodb` and cached in CI on the hash of
`packages/telemetry-mongo/test/server.ts`. That is deliberate: the behaviour the
exporter is built around — Mongo answering `IndexOptionsConflict` rather than
adopting a new `expireAfterSeconds` — is exactly what a double would have been
written to agree with.

`@nxgt/telemetry` is complete: the vocabulary, the root, the context, the
pipeline, `span`/`continuing`, the logger, and the console, JSON-lines and file
exporters. `@nxgt/telemetry-otlp` is complete: the two documents, the transport,
the retry policy and the three failures. `@nxgt/telemetry-hono` is
complete: the server span, the `traceparent` continuation, the route rename and
the context variables. `@nxgt/telemetry-httpyz` is complete: the client span,
the outgoing header and the 400 rule. `@nxgt/telemetry-mongo` is complete: the
exporter, its TTL retention, and command-monitoring spans.
`@nxgt/telemetry-logging` is still to come on the `feat/telemetry` integration
branch, and nothing has been published yet.
