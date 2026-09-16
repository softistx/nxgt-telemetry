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

## Usage

The whole life of a service, in the order you write it. Each step links to the
section that explains it.

**1. Install one telemetry at startup**, before anything logs.
[The root](#the-root)

```ts
// telemetry.ts
import { consoleExporter, createTelemetry } from '@nxgt/telemetry';

export const telemetry = createTelemetry('checkout', {
  version: '1.4.0',
  environment: 'production',
  exporters: [consoleExporter()],
}).install();
```

**2. Give each part of the code a logger.** A logger is cheap and has no
state; create it at module level. [Logging](#logging)

```ts
import { createLogger } from '@nxgt/telemetry';

const log = createLogger('CheckoutService');

log.info('checkout started', { cartSize: 3 });
```

**3. Declare the events that matter**, so a log line carries only the fields
you chose. [Declared event](#declared-event)

```ts
import { event } from '@nxgt/telemetry';
import { z } from 'zod';

const Charged = event('checkout.charged', z.object({ orderId: z.string(), amount: z.number() }));

log.info(Charged({ orderId: 'o-1', amount: 42 }));
```

**4. Wrap units of work in spans.** Everything inside a span, logs included,
carries its `traceId`. [Spans](#spans)

```ts
import { span } from '@nxgt/telemetry';

export async function checkout(orderId: string) {
  return span('checkout', { attributes: { orderId } }, async (scope) => {
    const order = await span('order.load', () => orders.find(orderId));
    scope.attribute('order.total', order.total);
    await span('payment.charge', { kind: 'client' }, () => payments.charge(order));
    log.info(Charged({ orderId, amount: order.total }));   // carries the trace
    return order;
  });
}
```

**5. Carry the trace across services.** Continue the caller's `traceparent` on
the way in and send the current one on the way out.
[Propagation](#propagation-and-traceparent)

```ts
import { continuing, currentTraceparent } from '@nxgt/telemetry';

// in: an HTTP handler
await continuing(request.headers.get('traceparent'), 'POST /checkout', { kind: 'server' }, () =>
  checkout(orderId),
);

// out: an HTTP call made inside a span
await fetch('https://stock.internal/reserve', {
  method: 'POST',
  headers: { traceparent: currentTraceparent() ?? '' },
});
```

With Hono and httpyz, the two integrations do both halves for you:
[`@nxgt/telemetry-hono`](https://www.npmjs.com/package/@nxgt/telemetry-hono)
and [`@nxgt/telemetry-httpyz`](https://www.npmjs.com/package/@nxgt/telemetry-httpyz).

**6. Put request-wide facts in scope once**, instead of passing them to every
log call. [Context](#context)

```ts
import { withAttributes } from '@nxgt/telemetry';

await withAttributes({ tenant: 'acme' }, () => checkout(orderId));
```

**7. Ship the signals somewhere.** Swap the console for a collector, a file or
MongoDB. The code from steps 2 to 6 does not change. [Exporters](#exporters)

```ts
import { otlpExporter } from '@nxgt/telemetry-otlp';

createTelemetry('checkout', {
  sampler: ratioSampler(0.1),   // keep one trace in ten; logs are never sampled
  exporters: [otlpExporter({ endpoint: 'http://localhost:4318' })],
}).install();
```

**8. Close it on shutdown, and await it**, or the last batch is lost.
[The root](#the-root)

```ts
process.on('SIGTERM', async () => {
  await telemetry.close();
  process.exit(0);
});
```

**In a test**, give each suite its own telemetry and an exporter that keeps
what it receives, instead of installing one globally.
[Context](#context)

```ts
import type { Exporter, Signal } from '@nxgt/telemetry';
import { createTelemetry, withTelemetry } from '@nxgt/telemetry';

const received: Signal[] = [];
const collect: Exporter = { export: (_resource, batch) => void received.push(...batch) };
const telemetry = createTelemetry('test', { exporters: [collect] });

await withTelemetry(telemetry, () => checkout('o-1'));
await telemetry.close();   // flushes: `received` now holds the spans and logs
```

## Concepts

Every word this library uses, once, with the smallest example that shows it.
The sections after this one go deeper; this is the glossary to come back to.

### Telemetry

The root object: one per service. It knows **who** is speaking (the resource),
**how much** to keep (the sampler, the minimum severity) and **where** signals go
(the exporters). Everything else — spans, loggers — finds it through the context,
or falls back to the one `install()`ed.

```ts
const telemetry = createTelemetry('checkout', {
  exporters: [consoleExporter()],
}).install();

await telemetry.close();   // ships what is left; must be awaited
```

### Resource

What every signal from one telemetry is about: the service, its version, its
environment, and any attributes you add. It is stamped once, not repeated by
each call site.

```ts
createTelemetry('checkout', {
  version: '1.4.0',
  environment: 'production',
  attributes: { 'deployment.region': 'eu-west-1' },
});
// telemetry.resource
// → { service: 'checkout', version: '1.4.0', environment: 'production',
//     attributes: { 'deployment.region': 'eu-west-1' } }
```

### Signal

The unit an exporter receives. There are two kinds, told apart by `type`: a
**log record** and a **span record**. Metrics would be a third kind; nothing
else would have to change.

```ts
function describe(signal: Signal): string {
  return signal.type === 'log'
    ? `${signal.severity} ${signal.name}`
    : `${signal.name} took ${signal.endedAt - signal.startedAt} ms`;
}
```

### Trace

All the work done for one request, across every service it touched. It has no
object of its own: it is every span that shares one **trace id**.

```ts
await span('GET /orders/:id', { kind: 'server' }, async () => {
  await span('load order', {}, async () => { /* … */ });
  await span('price order', {}, async () => { /* … */ });
});
// three spans, one traceId: that is the trace
```

### Span

One timed piece of work inside a trace: a name, a start, an end, a status, and
the span it happened inside (its **parent**). A span is a block you `await`, and
the block's lifetime *is* the span's.

```ts
const total = await span('price order', { attributes: { orderId } }, async (scope) => {
  scope.attribute('items', order.items.length);
  return computeTotal(order);
});
```

A span with no parent is a **root span**. The block's return value comes back
out; a thrown error goes back out too, after being recorded.

### Span scope

What the block receives: the handle on the span that is open. Through it you
name the span, add attributes and events, set or read the status, or record a
failure you caught and chose not to rethrow.

```ts
await span('charge', {}, async (scope) => {
  scope.name = `charge ${provider}`;      // renamed once the provider is known
  scope.event('gateway.called', { attempt: 1 });
  try {
    await gateway.charge(card);
  } catch (failure) {
    scope.fail(failure);                   // status → error, exception recorded
    await queue.retryLater(card);          // …and handled, not rethrown
  }
});
```

### Span kind

What role the span played: `internal` (the default), `server` (it answered a
request), `client` (it made one), `producer` and `consumer` (it sent or received
a message). A backend draws the arrows between services from `server` and
`client`.

```ts
await span('GET /orders/:id', { kind: 'server' }, handle);
await span('GET inventory', { kind: 'client' }, () => fetch(url));
```

### Span status

How the work ended: `ok`, `error`, or `cancelled`. A thrown error makes it
`error`; an `AbortError` or `TimeoutError` makes it `cancelled`, because a
shutdown or a timeout is not a bug somebody should be paged for.

```ts
await span('import', {}, async () => {
  throw new Error('bad row');              // status: 'error', rethrown
}).catch(() => {});

await span('poll', {}, async () => {
  await fetch(url, { signal: AbortSignal.timeout(10) });  // status: 'cancelled'
}).catch(() => {});
```

### Span event

Something that happened at an instant during a span, with its own attributes —
a retry, a cache miss, a state change. Cheaper than a child span, and attached
to the work it describes.

```ts
await span('charge', {}, async (scope) => {
  scope.event('retry', { attempt: 2, reason: 'timeout' });
});
```

### Span context

A span's place in a trace, as it travels: the trace id, the span id, whether the
trace is **sampled**, and whether it arrived from another process (**remote**).
It is what a `traceparent` header carries, and what a log attaches.

```ts
currentSpan();
// → { traceId: '4bf92f35…0e4736', spanId: '00f067aa0ba902b7', sampled: true, remote: false }
```

Ids are lowercase hex — 32 characters for a trace, 16 for a span — and typed as
`TraceId` and `SpanId`, so the compiler refuses one where the other belongs.

### Detached context

What a span carries when **no telemetry is installed**: all-zero ids, not
sampled. The block runs, nothing is emitted. It is what lets a library use
`span()` inside an application that has never heard of this package.

```ts
await span('work', {}, async (scope) => {
  isDetached(scope.context);   // true when nothing is installed
});
```

### Propagation and `traceparent`

How a trace crosses a process boundary: the caller writes its span context into
a W3C `traceparent` header, and the callee **continues** the trace from it
instead of starting a new one.

```ts
// the caller
await fetch(url, { headers: { traceparent: currentTraceparent() ?? '' } });

// the callee
await continuing(request.headers.get('traceparent'), 'GET /orders', async () => {
  // same traceId as the caller; this span's parent is the caller's span
});
```

`@nxgt/telemetry-httpyz` and `@nxgt/telemetry-hono` do both halves for you.

### Context

Where the current span, the current telemetry and the inherited attributes
live, so that nothing has to be passed by hand. It is an `AsyncLocalStorage`:
it follows your work through every `await`, timer and promise, and two
concurrent requests never see each other's.

```ts
await span('request', {}, async () => {
  await Promise.all([a(), b()]);   // both see 'request' as their current span
});
currentSpan();                     // undefined: out here, nothing is open
```

### Attributes

Key–value pairs describing a signal, where a value is a **scalar or a list of
scalars** — what a backend can filter and group by. Names follow OpenTelemetry's
conventions where one exists (`http.route`, `db.system.name`).

```ts
span('charge', { attributes: { orderId: 'o-1', amount: 4200, retried: false } }, block);
```

### Attribute inheritance

Attributes given to `span()` or `withAttributes()` are **inherited** by every log
and span inside the block. Those set with `scope.attribute()` belong to that one
span. When two names clash, the inner one wins.

```ts
await withAttributes({ tenant: 'acme' }, async () => {
  await span('charge', { attributes: { orderId: 'o-1' } }, async (scope) => {
    scope.attribute('provider', 'stripe');   // this span only
    log.info('charged');                      // carries tenant and orderId
  });
});
```

### Logger and source

A logger is named for the component that writes through it — its **source** —
and every record it produces carries that name. Loggers are cheap and can be
created at module level: they find the telemetry when they write, not when they
are made.

```ts
const log = createLogger('CheckoutService');
log.info('order stored', { orderId });
```

### Severity

How much a log matters: `debug`, `info`, `warn`, `error`. There is no `trace`.
The telemetry's **minimum** is the floor: below it a log is never built.

```ts
createTelemetry('checkout', { minimum: 'warn' });
log.info('ignored');          // below the floor: not built, not emitted
log.warn('kept');
```

### Log record

What a log call produces: when, how severe, a name, the source, attributes, the
span it was written in (if any) and the failure it is about (if any).

```ts
log.error('charge failed', new Error('card refused'), { orderId: 'o-1' });
// → { type: 'log', severity: 'error', name: 'charge failed',
//     source: 'CheckoutService', attributes: { orderId: 'o-1' },
//     span: { traceId, spanId, … }, error: { type: 'Error', message: 'card refused', stackTrace } }
```

### Declared event

A log whose fields are **declared by a schema**, so only what the schema names
is written. It is how a log stops leaking the field someone adds to an object
next quarter.

```ts
const Charged = event('checkout.charged', z.object({ orderId: z.string(), amount: z.number() }));

log.info(Charged({ orderId: 'o-1', amount: 4200, card: '4242…' }));
// → name 'checkout.charged', attributes { orderId: 'o-1', amount: 4200 } — no card
```

Any [Standard Schema](https://standardschema.dev) works. A value the schema
refuses is still logged, marked `telemetry.event.invalid`, never thrown.

### Error info

A failure flattened into something that can cross a wire: its type (the class
name), its message, and its stack as text. Logs and spans carry it the same way,
and OTLP turns it into `exception.type`, `exception.message` and
`exception.stacktrace`.

```ts
class ChargeRefused extends Error {}
errorInfo(new ChargeRefused('insufficient funds'));
// → { type: 'ChargeRefused', message: 'insufficient funds', stackTrace: '…' }
```

### Sampler and sampling

The decision to **keep a trace or not**, taken once by the root span and carried
by every child and every `traceparent`. It is a function of the trace id, so two
services at the same ratio agree. Logs are never sampled.

```ts
createTelemetry('checkout', { sampler: ratioSampler(0.1) });   // keep a tenth of traces

const custom: Sampler = { sample: (traceId) => traceId.endsWith('0') };
```

### Exporter

Where signals go: one object with `export(resource, batch)` and an optional
`close()`. It is called by one consumer at a time, in order, and a failure in it
never reaches the code that wrote the signal.

```ts
const counting: Exporter = {
  export(resource, batch) {
    console.log(`${resource.service}: ${batch.length} signals`);
  },
};
createTelemetry('checkout', { exporters: [counting, consoleExporter()] });
```

Built in: `consoleExporter`, `jsonLinesExporter`, `fileExporter`. Elsewhere:
`otlpExporter` (`@nxgt/telemetry-otlp`), `mongoExporter`
(`@nxgt/telemetry-mongo`), `winstonExporter` (`@nxgt/telemetry-logging`).

### Pipeline and batch

Between the code that writes a signal and the exporters: a queue that **never
blocks and never throws** at the writer. Signals are grouped into a **batch**,
flushed when `batch` signals are waiting or `linger` ms after the first one, and
drained by `close()`.

```ts
createTelemetry('checkout', {
  batch: 512,          // flush at this many
  linger: 1_000,       // …or this long after the first
  drainTimeout: 10_000,
  onExportError: (failure) => console.error('export failed', failure),
  exporters: [otlpExporter({ endpoint })],
});
```

## The root

```ts
import { createTelemetry, consoleExporter, ratioSampler } from '@nxgt/telemetry';

const telemetry = createTelemetry('checkout', {
  version: '1.4.0',
  environment: 'production',
  sampler: ratioSampler(0.1),
  exporters: [consoleExporter()],
}).install();

process.on('SIGTERM', async () => {
  await telemetry.close();
  process.exit(0);
});
```

`service` has no default: it is the key everything groups by, and a service
called `unknown` is a dashboard nobody can read. `install()` makes this the
telemetry a logger or a span finds when there is none in scope, and returns the
instance.

**`close()` must be awaited.** JavaScript cannot block, so unlike its JVM
counterpart this one returns a promise: a process that exits without waiting
loses its last batch, which is the batch that explains the shutdown. Handing the
promise to a listener that discards it is the same mistake in a smaller
disguise — the handler above awaits it before exiting. `await using` works too.

`drainTimeout` bounds **the whole close**, the exporters' own `close` included,
so neither a collector that stopped answering nor an exporter that will not let
go of its socket becomes the reason a process will not exit. A drain that runs
out of time is reported to `onExportError`, and is the one case where an
exporter's `close` may be called while an `export` is still in flight.

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

## Spans

```ts
import { span, continuing } from '@nxgt/telemetry';

await span('charge', { attributes: { orderId } }, async (scope) => {
  scope.event('gateway.called', { attempt });
  await payments.charge(card);
});

// on the way in, continuing whatever the caller started
await continuing(request.headers.get('traceparent'), 'GET /orders', async (scope) => {
  scope.name = `GET ${route}`;            // routing knows the template last
  scope.attribute('http.route', route);
});
```

The block runs whether or not a telemetry is installed: a library that traces
must work inside an application that has never heard of this one. With none, the
scope carries a detached context and nothing is emitted.

**A span never swallows.** A failure marks it `error` — or `cancelled`, for an
`AbortError` or a `TimeoutError`, because a shutdown and a timeout are not
failures — records the exception, and rethrows. A span observes; it does not
handle.

Attributes given to `span()` are inherited by every log and span inside it;
`scope.attribute()` belongs to that span alone. Both appear on the span's own
record.

`continuing` takes a header from a stranger, so an unusable one is not an error:
it starts a fresh trace, exactly as `span` would.

## Logging

```ts
import { createLogger, event } from '@nxgt/telemetry';
import { z } from 'zod';

const Charged = event('checkout.charged', z.object({ orderId: z.string(), amount: z.number() }));
const log = createLogger('CheckoutService');

log.info(Charged({ orderId, amount }));          // a declared event
log.warn('charge refused', { orderId, code });   // ad hoc, for what has no type yet
log.debug(() => `state: ${expensive()}`);        // built only if debug is on
log.error('charge failed', failure, { orderId });
```

A line written inside a span carries that span's `traceId` and `spanId` without
being told, and the attributes the span and `withAttributes` put in scope.

**Declaring an event is the point.** Logging an object as it is logs the field
added next quarter — the card number included — and nobody finds out, because a
log that says too much still looks like a working log. The schema is the
declaration, and what it returns is what is emitted: an object schema's unknown
keys are gone. Any [Standard Schema](https://standardschema.dev) will do — Zod,
Valibot, ArkType — and none of them is a dependency here.

**Nothing on this path can fail.** No telemetry installed, a schema that refuses
the input, a schema that answers asynchronously, a lazy message that throws: the
line still comes out, marked, or is dropped in silence. `log.info` is a total,
synchronous function, callable from a constructor or from a `catch`.

The lazy form is `debug` and `info` only, and the failure form is `warn` and
`error` only — at those levels a message is always built, so a thunk would hide
only the cost of building it.

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

### The ones built in

```ts
import { consoleExporter, jsonLinesExporter, fileExporter } from '@nxgt/telemetry';

consoleExporter()                                     // one readable line per signal
jsonLinesExporter()                                   // one JSON object per line, on stdout
fileExporter({ path: 'logs/telemetry.jsonl' })        // the same, appended, with rotation
```

`fileExporter` **appends**: a restart continues the current file, and the period
is read from that file's modification time rather than from when the process
started, so a service that restarts hourly still rolls once a day. Rotation is
epoch-aligned — `every: 24h` rolls at UTC midnight, not 24 hours after a
restart — and an **empty file is never rolled**, so an idle service does not
accumulate a directory of empty archives. `close()` rolls nothing: a rolled file
is a finished period, and a shutdown is not one.

| option | default | |
| --- | --- | --- |
| `path` | — | the file. Its directory is created if it is missing |
| `maxSize` | `64 MiB` | roll at this size. `0` disables it |
| `every` | `24h` | roll when this period changes, in ms. `0` disables it |
| `keep` | `7` | how many rolled files to keep |
| `compress` | `false` | gzip a rolled file |

**This exporter owns its path.** It is the one stateful exporter here — it
remembers the file's size and age instead of asking the filesystem on every
batch — so give each path exactly one `fileExporter`. Concurrent batches are
serialised internally, and any failure throws away what it remembered, so an
external `logrotate`, a truncation or a full disk costs the batch it happened on
and nothing after it.

Neither line format carries the resource: a file belongs to one service, so
repeating its name on every line would be noise. An exporter that writes
somewhere shared — `@nxgt/telemetry-mongo` — stamps it instead.

`@nxgt/telemetry-otlp` and `@nxgt/telemetry-mongo` are the others.

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

| | |
| --- | --- |
| `createTelemetry(service, options?)` | builds one. See the option table above |
| `Telemetry` | `resource`, `sampler`, `minimum`, `stackTraces`, `emit(signal)`, `install()`, `close()` |
| `installedTelemetry()` | the installed default, if there is one |
| `uninstallTelemetry(telemetry?)` | for a test that wants the process back as it found it |
| `TELEMETRY_DEFAULTS` | the defaults, which are `stx-telemetry`'s |

### Context

| | |
| --- | --- |
| `currentSpan()`, `currentTraceparent()`, `currentAttributes()` | what is open right here |
| `withTelemetry(telemetry, fn)` | a different telemetry for the block; scope beats the installed default |
| `withAttributes(record, fn)` | attributes inherited by every log and span inside |
| `currentContext()`, `runWithContext(context, fn)`, `resolveTelemetry()` | the lower level, for an integration |
| `TelemetryContext` | `{ telemetry, span?, attributes }` |

### Exporting

| | |
| --- | --- |
| `Exporter` | `{ export(resource, batch), close?() }` |
| `consoleExporter(options?)` | one readable line per signal; `write` and `stackTraces` |
| `jsonLinesExporter(options?)` | one JSON object per line; `write` |
| `fileExporter(options)` | the same, appended to a file, with rotation |
| `DEFAULT_MAX_SIZE`, `DEFAULT_ROTATION_PERIOD` | 64 MiB and a UTC day |
| `rotationDue`, `rolledName`, `rolledOf`, `prunable`, `RotationPolicy` | the rotation decisions, for an exporter that writes its own files |
| `PipelineOptions` | what a `Telemetry` configures its queue with |

### Spans

| | |
| --- | --- |
| `span(name, options?, block)` | opens one. `options` is `{ attributes?, kind? }`, kind `internal` by default |
| `continuing(traceparent, name, options?, block)` | the same, continuing an inbound trace. Kind `server` by default |
| `SpanScope` | `context`, `traceId`, `spanId`, writable `name` and `status`, `traceparent()`, `attribute()`, `attributes()`, `event()` |
| `SpanOptions`, `SpanBlock` | |

### Logging

| | |
| --- | --- |
| `createLogger(source)` | `source` becomes the OTLP instrumentation scope |
| `Logger` | `enabled(severity)`, `debug`, `info`, `warn`, `error` |
| `event(name, schema?)` | declares an event type; the result is called with its fields |
| `TelemetryEvent`, `isTelemetryEvent(value)`, `INVALID_EVENT_ATTRIBUTE` | |
| `errorInfo(failure, stackTraces?)`, `isAbort(failure)` | how a thrown value is flattened, and what counts as cancelled |

### Trace identity

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
- **`exception.type` is the class name, not `error.name`.**
  `class ChargeRefused extends Error {}` is recorded as `ChargeRefused`, because
  `name` is inherited unless a subclass assigns it and the type is what a
  dashboard groups by. An assigned `name` still wins.
- **A detached scope's `traceparent()` is `00-0…0-0…0-00`**, which this
  library's own parser rejects. That happens only when nothing is installed, and
  `isDetached(scope.context)` is the guard before injecting a header.
- **A rolled file is named for the instant it was rolled**, not for the period
  it covers: `telemetry-20260915-000100.jsonl` holds the 14th. `keep` orders
  archives by the stamp and collision number it parses out of the name, not by
  the name as text — inside one second, `-9` is newer than `-12` as text, and
  the unsuffixed name is the oldest of the three.
- **A log is never sampled, a span is.** A span of an unsampled trace is not
  emitted at all — the block still runs — while its logs come out as usual,
  carrying the `traceId`. Do not read "no span" as "nothing happened".
- **`log.warn(message, x)` reads `x` as a failure unless it is a plain object.**
  An `Error`, a string, an array or a class instance is the failure; `{ code:
  51 }` is attributes. Pass both explicitly when it matters.
- **`close()` has to be awaited**, and a `process.exit()` before it resolves
  loses the last batch. Nothing can block the event loop to save you from that.
- **The queue is unbounded.** An application that outruns its collector grows an
  array, which a heap profile shows, rather than dropping the evidence of what
  it was doing. A bounded queue would answer back-pressure by losing signals or
  by blocking the application, and neither is an answer.
- **`node:async_hooks` is how the context travels**, and it is imported
  statically. A bundler that shims the builtin to an empty module gets a
  fallback: everything works, but the context stops propagating across `await`,
  so pass the span explicitly there. A bundler that refuses to resolve the
  builtin at all cannot load this package — alias it to an empty module.

## License

[MIT](LICENSE)
