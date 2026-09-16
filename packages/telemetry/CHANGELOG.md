# @nxgt/telemetry

## 0.2.0

### Minor Changes

- [#1](https://github.com/softistx/nxgt-telemetry/pull/1) [`e1132e5`](https://github.com/softistx/nxgt-telemetry/commit/e1132e5566711fe7637893fac7c382e82dab720a) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add the telemetry root, the context and the export pipeline.
  
  `createTelemetry(service, options)` builds a telemetry from its resource, its
  sampler and its exporters; `install()` makes it the one a logger or a span finds
  with nothing in scope, and `close()` — which must be awaited — ships the backlog
  and closes the exporters. `drainTimeout` bounds the whole of it, the exporters'
  own `close` included, so neither a collector that stopped answering nor an
  exporter that will not let go of its socket can keep a process alive.
  
  The current span and the inherited attributes travel in an `AsyncLocalStorage`,
  so they survive any number of `await`s, reach everything started inside a span,
  and never leak into a sibling task. `withAttributes` at the top level of an
  application, before any span, opens a context from the installed telemetry
  rather than dropping what it was given. `withTelemetry`, `withAttributes`,
  `currentSpan` and `currentTraceparent` are the verbs; a telemetry in scope beats
  the installed default.
  
  `Exporter` is one function over a batch, called from a single consumer that
  never runs two exports at once. Writing a signal is synchronous and total: the
  queue is unbounded, an exporter that throws is reported and the next one still
  receives the batch, and a signal written after `close()` is dropped rather than
  raised. `consoleExporter()` is the first exporter.

- [#3](https://github.com/softistx/nxgt-telemetry/pull/3) [`43bcd01`](https://github.com/softistx/nxgt-telemetry/commit/43bcd01665111c1638cc2481d6a34f3075c090f4) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `jsonLinesExporter` and `fileExporter`, and the rotation behind it.
  
  `jsonLinesExporter()` writes one JSON object per signal per line — what `jq`, a
  log shipper and a collector's file receiver all read. `fileExporter({ path })`
  writes the same format to a file and rotates it.
  
  Rotation is **epoch-aligned**: `every: 24h` rolls at UTC midnight, which is what
  somebody reading yesterday's file expects, rather than 24 hours after a restart.
  The exporter **appends**, and reads the current period from the file's
  modification time, so a service that restarts hourly still rolls once a day. An
  **empty file is never rolled** — rolling one produces an empty archive and
  resets the period, so an idle service would accumulate a directory of nothing —
  and `close()` rolls nothing, because a rolled file is a finished period and a
  shutdown is not one. `keep` orders archives by the stamp and collision number
  it parses out of each name rather than by the name as text — inside one second
  `-9` is newer than `-12` as text — and only ever matches this file's own
  archives.
  
  `fileExporter` owns its path: it is the one stateful exporter here, so give each
  path exactly one. Concurrent batches are serialised internally, and any failure
  throws away what it remembered, so an external `logrotate`, a truncation or a
  full disk costs the batch it happened on and nothing after it.
  
  Neither line format carries the resource: a file belongs to one service.
  
  The decisions are exported separately as `rotationDue`, `rolledName`,
  `rolledOf` and `prunable`, so an exporter that writes its own files can reuse
  them without reimplementing the one rule that is easy to get wrong.

- [#5](https://github.com/softistx/nxgt-telemetry/pull/5) [`4fb6bd0`](https://github.com/softistx/nxgt-telemetry/commit/4fb6bd06d848df102cab312241661e4bde6834f8) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `SpanScope.fail(failure)`, for recording a failure the span will not see
  thrown.
  
  A block that throws is already recorded without it. This exists for the
  frameworks that **catch**: Hono turns a handler's exception into a 500 and hands
  the middleware a normal return with the failure on `c.error`, so the only thing
  that knows what went wrong is that field. Without a way to hand it over, the
  span carries a status and no `exception.type` — which is the one thing a trace
  is read for.
  
  The first failure wins, so a framework that catches and then rethrows its own
  wrapper cannot replace the one nearest the cause. The cost is that an early
  `fail()` for something the block recovered from hides a later, unrelated
  exception, so it is for the failure the span is about. Like everything else on a
  scope it is synchronous and cannot throw, and it honours `stackTraces` and the
  abort rule exactly as a thrown failure does.
  
  **`stx-telemetry` has no counterpart**, and does not need one: Ktor's pipeline
  rethrows, so the span sees the exception itself. This is an addition on this
  side, not a vocabulary change — the severities, kinds, statuses, `traceparent`
  rules, sampling rule, attribute names and OTLP mapping are all untouched.

- [#2](https://github.com/softistx/nxgt-telemetry/pull/2) [`a48048e`](https://github.com/softistx/nxgt-telemetry/commit/a48048ece10a02f3b62042f2640743301cadb415) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `span`, `continuing` and the logger — the two verbs that produce signals.
  
  `span(name, options?, block)` opens a span around a block; `continuing(header,
  …)` does the same for a trace a caller already started, and an unusable header
  starts a fresh trace rather than failing a request. A child carries its parent's
  trace id and points at its span id, so a backend draws a tree rather than a
  list. The sampler is asked **once, for the root**: below one the answer is
  inherited, which is what keeps a trace whole instead of missing its middle.
  A span never swallows — a failure marks it `error`, or `cancelled` for an
  `AbortError` or a `TimeoutError`, and is rethrown.
  
  `createLogger(source)` writes lines that carry the current span and the
  attributes in scope without being told. `event(name, schema?)` declares an event
  type over any Standard Schema — Zod, Valibot, ArkType, none of them a dependency
  — and emits **what the schema returned**, so a field nobody declared never
  reaches a log. Nothing on this path can fail: no telemetry installed, a schema
  that refuses the input or answers asynchronously, a lazy message that throws —
  the line still comes out, marked, or is dropped in silence.
  
  Nothing on either path can be made to throw by the value it is given. A getter
  that raises, an `ownKeys` or `getPrototypeOf` trap, a revoked Proxy, an `Error`
  subclass whose `name` getter throws: each is read defensively, because the value
  comes out of a `catch` block. A span records its failure and rethrows **that**
  failure, never one of its own. `exception.type` is the class name, and an
  `Error` from another realm keeps its message.
  
  Logs are not sampled. A log of an unsampled trace still comes out, carrying its
  `traceId`, because a log dropped because its trace was not kept is a log missing
  at precisely the moment somebody is reading logs.

### Patch Changes

- [#11](https://github.com/softistx/nxgt-telemetry/pull/11) [`ac5e971`](https://github.com/softistx/nxgt-telemetry/commit/ac5e971a90f107259ffef5cd21a2f5e7a1ae6593) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add a **Concepts** section to the README: every word the library uses —
  telemetry, resource, signal, trace, span and its scope, kind, status and events,
  span context, the detached context, `traceparent` propagation, the context,
  attributes and their inheritance, loggers and severity, log records, declared
  events, error info, sampling, exporters and the pipeline — each defined once,
  with the smallest example that shows it.
