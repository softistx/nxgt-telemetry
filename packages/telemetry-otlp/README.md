# @nxgt/telemetry-otlp

Logs and traces from [`@nxgt/telemetry`](https://www.npmjs.com/package/@nxgt/telemetry)
to any OpenTelemetry collector, as OTLP/HTTP JSON — over `fetch`, with no
OpenTelemetry SDK.

```sh
bun add @nxgt/telemetry @nxgt/telemetry-otlp
```

```ts
import { createTelemetry } from '@nxgt/telemetry';
import { otlpExporter } from '@nxgt/telemetry-otlp';

createTelemetry('checkout', {
  version: '1.4.0',
  environment: 'production',
  exporters: [otlpExporter({ endpoint: 'http://localhost:4318' })],
}).install();
```

## What it is

OTLP is a **wire format**, not a library. The whole of it a collector needs is
two JSON documents over HTTP, and that is what this package writes — which is
why it has one dependency, no transitive tree, and nothing that wants to own
your context propagation.

The alternative is the OpenTelemetry JavaScript SDK: an exporter, a processor, a
provider, a context manager and a propagator, forty-odd packages between them,
and a `Context` that has to be wired to `AsyncLocalStorage` anyway. This is the
same bytes on the socket.

Everything it sends is checked against a real HTTP server in the specs, not
against a `fetch` double: a hand-written wire format has to be read over a wire
at least once.

## The collector

```ts
otlpExporter({
  endpoint: 'http://localhost:4318',
  headers: { 'x-api-key': key },
})
```

`endpoint` is the base URL. `/v1/logs` and `/v1/traces` are appended, which is
where every collector listens; `logsPath` and `tracesPath` move them for a
gateway that mounts OTLP somewhere else.

| option | default | |
| --- | --- | --- |
| `endpoint` | — | the collector's base URL |
| `logsPath` | `/v1/logs` | appended to `endpoint` |
| `tracesPath` | `/v1/traces` | appended to `endpoint` |
| `headers` | — | sent on every request — an API key, a tenant |
| `timeout` | `10s` | per attempt |
| `attempts` | `3` | how many requests one document gets. `1` disables retrying |
| `backoff` | `500ms` | the first wait between attempts, doubled each time |
| `gzip` | `true` | compress a document over 1 KiB |
| `onPartialSuccess` | — | called when the collector kept the request but not every record |
| `fetch` | global | for a specs double, or an application that routes its own traffic |

## A mixed batch is two requests

A batch of logs and spans becomes one `/v1/logs` POST and one `/v1/traces` POST,
sent together. Logs failing must not cost the traces of the same batch, so both
are attempted before either failure is thrown. A batch with nothing of one kind
makes no request of that kind: an empty document is a request worth not making.

## When it fails

Every failure is thrown out of `export`, which means it reaches
`onExportError` and nothing else. A collector being down is not a reason for a
request to fail.

| | when | retried |
| --- | --- | --- |
| `OtlpUnreachableError` | no answer at all — DNS, a refused connection, the timeout | yes, to the end of `attempts` |
| `OtlpRefusedError` | `408`, `429`, `500`, `502`, `503`, `504` | yes, to the end of `attempts` |
| `OtlpRejectedError` | any other status | **no** |

A rejection is not retried because sending the same bytes again gets the same
answer: the collector is saying the request is wrong, not that it is busy. All
three carry `endpoint`, `signal` (`'logs'` or `'traces'`) and `attempts`; the
two that had an answer carry its `status` and the first 500 characters of its
body.

```ts
createTelemetry('checkout', {
  exporters: [otlpExporter({ endpoint })],
  onExportError: (failure) => {
    if (failure instanceof OtlpRejectedError) alert.page(failure);   // we are misconfigured
    else metrics.increment('telemetry.export.failed');               // they are down
  },
});
```

## Partial success

A collector that took the request but threw some records away answers `200`
with a `partialSuccess`. That is **not** retried — it already accepted
everything else, and sending the bytes again would duplicate them.

```ts
otlpExporter({
  endpoint,
  onPartialSuccess: ({ signal, rejected, message }) =>
    console.warn(`collector dropped ${rejected} ${signal}: ${message}`),
})
```

The hook is what decides whether the body is read at all: without one, the
ordinary empty answer is never parsed.

## The conversion

| this library | OTLP |
| --- | --- |
| epoch milliseconds | `timeUnixNano`, as a **decimal string** |
| `TraceId` / `SpanId` | lowercase hex, **not** base64 |
| `debug` `info` `warn` `error` | `5` `9` `13` `17`, with the name as `severityText` |
| `internal`…`consumer` | `1`…`5` |
| `ok` / `error` / `cancelled` | `1` / `2` / **`0`** |
| the log's `name` | the record `body` |
| the logger's `source` | one `ScopeLogs` per source |
| a span | one `ScopeSpans` named `nxgt-telemetry` |
| `service`, `version`, `environment` | `service.name`, `service.version`, `deployment.environment.name` |
| `ErrorInfo` | `exception.type`, `exception.message`, `exception.stacktrace`, on logs and spans alike |
| a whole number | `intValue`, as a string |
| a fractional number | `doubleValue` |
| `null` | the unset value, `{}` |

`cancelled` maps to **unset**, not error. A shutdown and a timeout are not
failures, and OTLP has no third code, so the honest answer is to say nothing
rather than to say "failed".

The converter is exported — `logsRequest`, `tracesRequest`, `otlpResource`,
`anyValue`, `keyValues`, `nanos` — so a transport this package does not have
(gRPC, a queue, a file of OTLP documents) can be written without redoing it.

## API

### Exporting

| | |
| --- | --- |
| `otlpExporter(options)` | an `Exporter` that POSTs OTLP/HTTP JSON |
| `OtlpExporterOptions` | the options above |
| `PartialSuccessReport` | `{ signal, rejected, message }` |
| `RETRYABLE` | the statuses worth sending the same bytes again for |
| `DEFAULT_LOGS_PATH`, `DEFAULT_TRACES_PATH` | `/v1/logs`, `/v1/traces` |
| `DEFAULT_TIMEOUT`, `DEFAULT_ATTEMPTS`, `DEFAULT_BACKOFF` | `10_000`, `3`, `500` |
| `COMPRESSION_FLOOR` | `1024` — below it, compressing costs more than it saves |

### Failures

| | |
| --- | --- |
| `OtlpError` | the shared base: `endpoint`, `signal`, `attempts` |
| `OtlpUnreachableError` | no answer; carries the `cause` `fetch` threw |
| `OtlpRefusedError` | a retryable status that kept coming back; `status`, `body` |
| `OtlpRejectedError` | a status that will not change; `status`, `body` |
| `OtlpSignal` | `'logs' \| 'traces'` |
| `BODY_LIMIT` | `500` — how much of an answer is kept |

### Converting

| | |
| --- | --- |
| `logsRequest(resource, batch)` | the `/v1/logs` document, or `undefined` |
| `tracesRequest(resource, batch)` | the `/v1/traces` document, or `undefined` |
| `otlpResource(resource)` | the resource, with the three conventional keys |
| `anyValue(value)`, `keyValues(attributes)` | an attribute, tagged the way OTLP tags it |
| `nanos(at)` | epoch milliseconds as decimal nanoseconds |
| `SPAN_SCOPE`, `STATUS_CODE` | `'nxgt-telemetry'`, the status mapping |

### The documents

`AnyValue`, `KeyValue`, `OtlpResource`, `InstrumentationScope`,
`OtlpLogRecord`, `ScopeLogs`, `ResourceLogs`, `ExportLogsServiceRequest`,
`OtlpSpan`, `OtlpSpanEvent`, `OtlpStatus`, `ScopeSpans`, `ResourceSpans`,
`ExportTraceServiceRequest`, `PartialSuccess` — types only, hand-written from
the specification.

## Traps

- **`nanos` goes through `BigInt`, and has to.** `Date.now() * 1e6` passed
  `Number.MAX_SAFE_INTEGER` in 2001, so the float path answers the same instant
  for two signals a microsecond apart. That is also why the field is text on the
  wire.
- **Ids are hex, not base64.** Proto3 JSON would encode a `bytes` field as
  base64; the OTLP specification overrides that for `trace_id`, `span_id` and
  `parent_span_id`, and a collector that reads base64 there sees a different
  trace.
- **A retry is `.unref()`ed**, so a process that has nothing else to do exits
  rather than waiting out a backoff. Telemetry must not be the reason a
  container takes thirty seconds to stop; `close()`'s `drainTimeout` is the
  other half of that.
- **`Retry-After` is not read.** The backoff is the one this exporter was given,
  doubled. A collector that asks for longer gets the same schedule.
- **gzip needs `node:zlib`.** A bundle for the browser that shims the builtin
  away still exports — uncompressed, which every collector accepts — rather
  than failing to load.
- **The batch is gone when `export` throws.** There is no disk queue behind
  this. A collector that is down for longer than the retries costs those
  batches; `fileExporter` beside this one is what an estate that cannot afford
  that uses.

## License

MIT
