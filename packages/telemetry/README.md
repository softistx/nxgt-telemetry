# @nxgt/telemetry

Logs and traces for a TypeScript service, with no OpenTelemetry SDK.

```sh
bun add @nxgt/telemetry
```

Zero runtime dependencies. Bun and Node; a browser gets everything but the
automatic context.

## What it is

A span is a block you `await`, and the current one travels with your work —
through every `await`, every timer, every promise — in an `AsyncLocalStorage`.
Logs written inside it carry its `traceId` and `spanId` without being told. A
`traceparent` header is read on the way in and written on the way out, so the
trace continues across services. Signals are handed to a pipeline that never
blocks the caller and never throws at it, and exporters ship them: the console,
a file, [OTLP](https://www.npmjs.com/package/@nxgt/telemetry-otlp), MongoDB.

It is the TypeScript counterpart of `stx-telemetry` on the JVM, and shares its
vocabulary exactly: the same severities, span kinds, statuses, `traceparent`
rules, sampling rule and attribute names. A trace started in one and continued
in the other is one trace.

## The root

```ts
import { createTelemetry, consoleExporter, ratioSampler } from '@nxgt/telemetry';

const telemetry = createTelemetry('checkout', {
  version: '1.4.0',
  environment: 'production',
  sampler: ratioSampler(0.1),
  exporters: [consoleExporter()],
}).install();

process.on('SIGTERM', () => telemetry.close());
```

`service` has no default: it is the key everything groups by, and a service
called `unknown` is a dashboard nobody can read. `install()` makes this the
telemetry a logger or a span finds when there is none in scope, and returns the
instance.

**`close()` must be awaited.** JavaScript cannot block, so unlike its JVM
counterpart this one returns a promise: a process that exits without waiting
loses its last batch, which is the batch that explains the shutdown. It races
the drain against `drainTimeout`, so a collector that stopped answering never
becomes the reason a process will not exit. `await using` works too.

| option | default | |
| --- | --- | --- |
| `version`, `environment`, `attributes` | — | stamped on the resource, so every signal carries them |
| `sampler` | `alwaysSample` | asked once, for a root span |
| `minimum` | `'info'` | logs below this are never built. Spans are unaffected |
| `stackTraces` | `true` | whether a recorded failure carries its stack |
| `batch` | `512` | flush once this many signals are waiting |
| `linger` | `1000` ms | flush this long after the first signal of a batch |
| `drainTimeout` | `10000` ms | how long `close` waits for the backlog |
| `onExportError` | `console.error` | a failing exporter is reported here |
| `exporters` | `[]` | in order; a batch reaches them one after the other |

## Context

```ts
import { currentSpan, currentTraceparent, withAttributes, withTelemetry } from '@nxgt/telemetry';

await withAttributes({ tenant: 'acme' }, async () => {
  // every log and span in here carries tenant=acme
  await fetch(url, { headers: { traceparent: currentTraceparent() ?? '' } });
});
```

The current span lives in an `AsyncLocalStorage`, and that is the whole design.
It propagates through every `await`, every timer and every promise chain: into
everything started inside a span, out of nothing, and correct after any number
of suspensions. A module-level variable would look right in development and
start attributing one request's spans to another under concurrency — a bug with
no stack trace and no failing test, in the tool meant to make such bugs visible.

It is also readable **synchronously**, which is what lets `log.info()` stay a
plain function: a log written from a constructor, from a `catch` in ordinary
code or from a callback still has to come out.

`withTelemetry(telemetry, fn)` puts a different one in scope for the block.
Scope wins over the installed default, which is what lets two suites in one
process each collect their own signals.

## Exporters

An exporter is one function:

```ts
import type { Exporter } from '@nxgt/telemetry';

const exporter: Exporter = {
  export(resource, batch) { /* … */ },
  async close() { /* optional */ },
};
```

The pipeline guarantees it is called from **one consumer, never concurrently**,
so there is nothing to synchronise and a batch's order is the order things
happened in. It may take as long as it wants; nothing that writes a signal is
waiting on it. If it throws, the failure goes to `onExportError` and the next
exporter still receives the batch — a collector being down is not a reason for
a request to fail.

`consoleExporter()` is built in. `@nxgt/telemetry-otlp` and
`@nxgt/telemetry-mongo` are the others.

## Trace identity

```ts
import { randomTraceId, parseTraceparent, renderTraceparent } from '@nxgt/telemetry';

const incoming = parseTraceparent(request.headers.get('traceparent'));
// → { traceId, spanId, sampled, remote: true }, or null

renderTraceparent({ traceId, spanId, sampled: true, remote: false });
// → '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
```

`parseTraceparent` **returns `null` and never throws.** A header a stranger
controls must not be able to fail a request: an unusable one simply starts a
fresh trace. It rejects fewer than four fields, a version that is not two hex
characters, the forbidden version `ff`, an id of the wrong length or all zeros
or not hex, and flags that are not hex. A later version is accepted and its
extra fields ignored. `tracestate` is not read, and nothing here writes one.

`TraceId` and `SpanId` are branded strings: the hex is the representation, so
there is nothing to convert before writing a header, and the compiler still
refuses a span id where a trace id belongs. `isValidTraceId` and
`isValidSpanId` are the guards that turn a `string` into one.

## Sampling

```ts
import { ratioSampler, alwaysSample, neverSample } from '@nxgt/telemetry';

const sampler = ratioSampler(0.1);   // keep a tenth of traces
```

The sampler is asked **once, for the root span**, and the answer travels with
the trace — down through every child and out in the `traceparent`. A sampler
consulted per span produces traces missing their middles, and a gap in a trace
looks like work that never happened.

The decision is a function of the trace id, not a coin toss, and the rule is
OpenTelemetry's: two services at the same ratio make the **same** decision about
the same trace. Two services tossing independently at 10% keep a whole trace 1%
of the time.

**Logs are never sampled.** A log dropped because its trace was not kept is a
log missing at precisely the moment somebody is reading logs to find out what
happened. The `traceId` is attached either way, so an unsampled trace's logs
still group.

## Attributes

An attribute is a **scalar, or a list of scalars** — that is what a backend can
index, filter and group by, and what OTLP accepts. Anything with structure is an
event type, not an attribute.

```ts
import { attributesOf } from '@nxgt/telemetry';

attributesOf({ orderId: 'o-1', amount: 4200, retried: false });
attributesOf({ orderId: 'o-1', code: undefined });   // → { orderId: 'o-1' }
```

The coercion never refuses a value, because a log call must not fail: a
non-finite number, a `bigint` and a `Date` become text, an object becomes its
JSON, and a circular object still says something. `undefined` is dropped — one
absent field should not log `null` — while an explicit `null` is kept, because
somebody wrote it.

## API

### The root

```ts
import { createTelemetry, consoleExporter, ratioSampler } from '@nxgt/telemetry';

const telemetry = createTelemetry('checkout', {
  version: '1.4.0',
  environment: 'production',
  sampler: ratioSampler(0.1),
  exporters: [consoleExporter()],
}).install();

process.on('SIGTERM', () => telemetry.close());
```

`service` has no default: it is the key everything groups by, and a service
called `unknown` is a dashboard nobody can read. `install()` makes this the
telemetry a logger or a span finds when there is none in scope, and returns the
instance.

**`close()` must be awaited.** JavaScript cannot block, so unlike its JVM
counterpart this one returns a promise: a process that exits without waiting
loses its last batch, which is the batch that explains the shutdown. It races
the drain against `drainTimeout`, so a collector that stopped answering never
becomes the reason a process will not exit. `await using` works too.

| option | default | |
| --- | --- | --- |
| `version`, `environment`, `attributes` | — | stamped on the resource, so every signal carries them |
| `sampler` | `alwaysSample` | asked once, for a root span |
| `minimum` | `'info'` | logs below this are never built. Spans are unaffected |
| `stackTraces` | `true` | whether a recorded failure carries its stack |
| `batch` | `512` | flush once this many signals are waiting |
| `linger` | `1000` ms | flush this long after the first signal of a batch |
| `drainTimeout` | `10000` ms | how long `close` waits for the backlog |
| `onExportError` | `console.error` | a failing exporter is reported here |
| `exporters` | `[]` | in order; a batch reaches them one after the other |

## Context

```ts
import { currentSpan, currentTraceparent, withAttributes, withTelemetry } from '@nxgt/telemetry';

await withAttributes({ tenant: 'acme' }, async () => {
  // every log and span in here carries tenant=acme
  await fetch(url, { headers: { traceparent: currentTraceparent() ?? '' } });
});
```

The current span lives in an `AsyncLocalStorage`, and that is the whole design.
It propagates through every `await`, every timer and every promise chain: into
everything started inside a span, out of nothing, and correct after any number
of suspensions. A module-level variable would look right in development and
start attributing one request's spans to another under concurrency — a bug with
no stack trace and no failing test, in the tool meant to make such bugs visible.

It is also readable **synchronously**, which is what lets `log.info()` stay a
plain function: a log written from a constructor, from a `catch` in ordinary
code or from a callback still has to come out.

`withTelemetry(telemetry, fn)` puts a different one in scope for the block.
Scope wins over the installed default, which is what lets two suites in one
process each collect their own signals.

## Exporters

An exporter is one function:

```ts
import type { Exporter } from '@nxgt/telemetry';

const exporter: Exporter = {
  export(resource, batch) { /* … */ },
  async close() { /* optional */ },
};
```

The pipeline guarantees it is called from **one consumer, never concurrently**,
so there is nothing to synchronise and a batch's order is the order things
happened in. It may take as long as it wants; nothing that writes a signal is
waiting on it. If it throws, the failure goes to `onExportError` and the next
exporter still receives the batch — a collector being down is not a reason for
a request to fail.

`consoleExporter()` is built in. `@nxgt/telemetry-otlp` and
`@nxgt/telemetry-mongo` are the others.

## Trace identity

| | |
| --- | --- |
| `TraceId`, `SpanId` | branded 32- and 16-character lowercase hex strings |
| `SpanContext` | `{ traceId, spanId, sampled, remote }` — a span's place in a trace, as it travels |
| `randomTraceId()`, `randomSpanId()` | from `crypto.getRandomValues`, never `Math.random()` |
| `isValidTraceId(hex)`, `isValidSpanId(hex)` | type guards: right length, lowercase hex, not all zeros |
| `renderTraceparent(context)` | the header value, version `00` |
| `parseTraceparent(header)` | a `SpanContext` with `remote: true`, or `null` |
| `INVALID_TRACE_ID`, `INVALID_SPAN_ID` | all zeros |
| `DETACHED_SPAN_CONTEXT`, `isDetached(context)` | what a span carries when no telemetry is installed |

### Sampling

| | |
| --- | --- |
| `Sampler` | `{ sample(traceId): boolean }` |
| `alwaysSample`, `neverSample` | the constants |
| `ratioSampler(ratio)` | keeps `ratio` of traces, by trace id. Throws `RangeError` outside `0..1` |

### Attributes

| | |
| --- | --- |
| `AttributeScalar`, `AttributeValue`, `Attributes` | a scalar, a scalar or list of them, and a read-only record of those |
| `attributesOf(record)` | coerces a record of anything; drops `undefined` |
| `coerceAttribute(value)` | one value, the same way |
| `mergeAttributes(left, right)` | the right-hand side wins; neither argument is modified |
| `isEmptyAttributes(attributes)`, `EMPTY_ATTRIBUTES` | |

### The signal model

| | |
| --- | --- |
| `Severity` | `'debug' \| 'info' \| 'warn' \| 'error'`. There is no `trace` level |
| `SEVERITY_NUMBER`, `SEVERITIES`, `meetsSeverity(severity, minimum)` | OTLP's numbers, ascending, and the floor test |
| `SpanKind`, `SPAN_KIND_NUMBER` | `internal` 1, `server` 2, `client` 3, `producer` 4, `consumer` 5 |
| `SpanStatus` | `'ok' \| 'error' \| 'cancelled'` |
| `Resource` | `{ service, version?, environment?, attributes }` |
| `LogRecord`, `SpanRecord`, `SpanEvent`, `ErrorInfo` | the records an exporter receives |
| `Signal` | `LogRecord \| SpanRecord`, discriminated on `type` |
| `signalAt(signal)`, `signalSpan(signal)` | when it happened, and which span it belongs to, whichever kind it is |

## Traps

- **There is no `trace` severity.** Detail below `debug` belongs on a span as an
  attribute, attached to the work it describes, rather than on a line somebody
  has to correlate by hand.
- **Instants are epoch milliseconds**, which is the precision a JavaScript wall
  clock has. OTLP wants nanoseconds, and the exporter multiplies; do not read a
  sub-millisecond duration out of a span.
- **A nested list is not an attribute.** `['a', ['b']]` is flattened into text
  rather than dropped — the value survives, but it stops being something a
  backend can group by. Put structure in an event type.
- **`ratioSampler` throws on a bad ratio**, at construction. That is the one
  place in this library that refuses an argument, and it is deliberate: it is
  not on the path that writes a signal.
- **`close()` has to be awaited**, and a `process.exit()` before it resolves
  loses the last batch. Nothing can block the event loop to save you from that.
- **The queue is unbounded.** An application that outruns its collector grows an
  array, which a heap profile shows, rather than dropping the evidence of what
  it was doing. A bounded queue would answer back-pressure by losing signals or
  by blocking the application, and neither is an answer.
- **`node:async_hooks` is how the context travels.** In a browser bundle where
  that builtin is shimmed away, everything still works but the context stops
  propagating across `await` — pass the span explicitly there.

## License

[MIT](LICENSE)
