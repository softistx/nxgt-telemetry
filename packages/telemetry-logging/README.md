# @nxgt/telemetry-logging

The [winston](https://www.npmjs.com/package/winston) bridge for
[`@nxgt/telemetry`](https://www.npmjs.com/package/@nxgt/telemetry), in both
directions — and never both at once on the same logger.

```sh
bun add @nxgt/telemetry @nxgt/telemetry-logging winston
```

Most applications already log. This is for those: it connects the logger you
have to the traces you are adding, without a rewrite and without running two
pipes.

## Trace ids on the lines you already write

```ts
import winston from 'winston';
import { telemetryFormat } from '@nxgt/telemetry-logging';

const logger = winston.createLogger({
  format: winston.format.combine(telemetryFormat(), winston.format.json()),
  transports: [new winston.transports.Console()],
});
```

Every line now carries `traceId` and `spanId`, plus the attributes in scope —
what `span()` and `withAttributes()` were given. That is the whole cost of
making a log search and a trace view answer each other.

Put it **before** the format that renders the line (`json()`, `printf()`,
`simple()`), or the fields will be added to something already turned into a
string. Outside any span it adds nothing at all, rather than a null: a field
that is present and empty is one a dashboard has to filter out. An ambient
attribute never replaces a field the call site set — `orderId` on the line means
that order.

```ts
telemetryFormat({ traceField: 'trace_id', spanField: 'span_id', attributes: false })
```

## winston lines into the pipeline

```ts
import { telemetryTransport } from '@nxgt/telemetry-logging';

logger.add(telemetryTransport({ source: 'CheckoutService' }));
```

Now the lines go wherever the telemetry's exporters go — OTLP, Mongo, a file —
with no call site changed. `level` and `message` become the record; everything
else the caller passed becomes attributes, and the span open at the time is
attached.

| | default | |
| --- | --- | --- |
| `source` | `winston` | what the lines are attributed to |
| `telemetry` | in scope, else installed | |
| `fallback` | `info` | what a level this library does not know becomes |
| `level` | the logger's | winston's own option, honoured here |
| `silent` | `false` | winston's own option |
| `handleExceptions` | `false` | whether a line from winston's `exceptionHandlers` is collected |

A line also has to clear the **telemetry's** `minimum`, not only winston's
level: two floors, because winston's decides what the logger writes at all and
the telemetry's decides what the pipeline keeps. An `Error` — as the message, as
`error` in the meta, or as the `stack` that `format.errors()` leaves behind —
becomes the record's `ErrorInfo`, so it reaches OTLP as `exception.type` and
`exception.stacktrace` rather than as text on an attribute. The attributes in
scope come along too, under whatever the line already carried.

A level winston knows and this does not — `crit` from a `syslog` level set, a
custom one — becomes `info`, and the direction matters: mapped to `debug` it
would be dropped by a pipeline with the default `minimum`, and a line that
disappears is worse than one recorded a shade too loudly. For the same reason a
line at a level the logger's own table does not know is **kept**, where
`winston-transport` drops it.

## Telemetry signals into a winston already in place

```ts
import { winstonExporter } from '@nxgt/telemetry-logging';

createTelemetry('checkout', {
  exporters: [winstonExporter({ logger })],
}).install();
```

For an application whose log shipping is solved — a rotation, a syslog
transport, a vendor's agent — and that wants `log.info(...)` from this library to
land in the same place as everything else.

Spans are **off** by default. A span is a duration and a set of attributes,
which is a poor fit for a line of text, and turning every one of them into a log
line is how a cheap trace becomes an expensive log bill. `spans: true` when the
lines are what you have; a **failed span is written at `error`** whatever
`spanSeverity` says, because that is the line somebody is looking for.

```ts
winstonExporter({ logger, spans: true, spanSeverity: 'debug' })
```

## Not both on the same logger

```
logger ──(transport)──▶ pipeline ──(exporter)──▶ logger ──▶ …
```

That is a loop, and a loop here does not crash: it spins, quietly, at whatever
rate the process can manage. `winstonExporter` **refuses it at construction**
when it can see the transport on the logger it was handed. What construction
cannot see — two loggers pointing at each other, or a transport added afterwards
— is caught on the line itself: every line this library writes into winston
carries a mark, and the transport drops a line that has it.

Pick a direction. The transport is for *collecting* winston into the pipeline;
the exporter is for *writing* the pipeline into winston. Both is neither.

## `@nxgt/shared-logging`

It needs nothing extra here. Its `Logger` **is** winston's own, so
`telemetryFormat()`, `telemetryTransport()` and `winstonExporter({ logger })`
all apply to it unchanged.

## API

| | |
| --- | --- |
| `telemetryFormat(options)`, `FormatOptions`, `TelemetryFormat` | the format |
| `telemetryTransport(options)`, `TelemetryTransport`, `TransportOptions` | the transport |
| `winstonExporter(options)`, `WinstonExporterOptions`, `WinstonLike` | the exporter |
| `severityOf(level, fallback)`, `levelOf(severity)` | the two directions of the mapping |
| `SEVERITY_OF_LEVEL`, `LEVEL_OF_SEVERITY` | the tables behind them |
| `FROM_TELEMETRY` | the mark that breaks the loop |
| `LogInfo` | what winston passes a format and a transport |

## Traps

- **The format goes first.** After `json()` or `printf()` the line is already a
  string, and the fields are added to something nothing will read.
- **`winston` is an optional peer, and nothing here imports it.** The format is
  a plain object with `transform`, and the transport extends `node:stream`'s
  `Writable` — which is exactly what `winston-transport` does. This package has
  **no runtime dependency**, so it installs in a workspace that has no winston
  at all.
- **A transport's `level` is enforced by the transport, not by the logger.**
  winston pipes every line to every transport and each one filters. This does
  the filtering the way `winston-transport` does, on `Symbol.for('level')` and
  the logger's own level table, which it learns from Node's `pipe` event — with
  one deliberate difference, the unknown level above. A spec runs both
  transports on the same logger and asserts they keep the same lines.
- **Uncaught exceptions are not collected unless you ask.** A line from
  winston's `exceptionHandlers` carries `exception: true`, and a transport
  without `handleExceptions` ignores it — winston's rule, followed here.
  Turning it on also puts this transport in winston's list of exception
  handlers, and winston then waits up to three seconds for each of them to emit
  `finish` before the process exits. A `process.on('uncaughtException')` that
  calls `log.error` and awaits `telemetry.close()` costs no exit delay.
- **A per-transport `format` is not supported.** winston lets a transport carry
  its own; this one does not, because the record is built from the line's
  fields and a format that rendered them to a string would leave nothing to
  build from. Put the format on the logger, after `telemetryFormat()`.
- **A line's own fields become attributes, including big ones.** Whatever is
  passed to `logger.info('…', meta)` is coerced through this library's scalar
  rule; an object becomes its rendering. If a line carries something large or
  secret, it carried it before this package too — but it now leaves the process
  by a second route.
- **Nothing here is sampled.** Logs never are, in this library; a winston line
  that lands in the pipeline is exported whether or not its trace was sampled.
  It still carries the `traceId`.
- **The exporter writes through winston's single-argument `log`.** The
  three-argument `log(level, message, meta)` tests the message against
  `/%[scdjifoO%]/` and, when it matches, treats the meta as printf arguments —
  which means a span named `GET /files/%s` would arrive with no `traceId`, no
  attributes, and none of the mark that stops this bridge looping.
- **A transport that throws would take the line down for every other transport
  on the logger.** This one cannot throw: the whole write is guarded, and a
  broken pipeline costs the telemetry, not the log.
- **The exporter writes synchronously through `logger.log`.** Whether the line
  has reached a file or a socket when `export` returns is winston's business,
  not this library's — `telemetry.close()` drains the pipeline, not winston.

## License

MIT
