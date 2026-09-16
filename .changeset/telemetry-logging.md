---
'@nxgt/telemetry-logging': minor
---

Add `@nxgt/telemetry-logging`: the winston bridge, in both directions.

```ts
// trace ids on the lines you already write
winston.createLogger({
  format: winston.format.combine(telemetryFormat(), winston.format.json()),
});

// those lines into the pipeline
logger.add(telemetryTransport({ source: 'CheckoutService' }));

// or the pipeline into a winston already in place
createTelemetry('checkout', { exporters: [winstonExporter({ logger })] }).install();
```

Most applications already log. `telemetryFormat()` is the half that costs
nothing to adopt: every existing line gains `traceId`, `spanId` and the
attributes in scope, which is all it takes for a log search and a trace view to
answer each other. It goes **before** the format that renders the line, adds
nothing at all outside a span rather than a null, and never replaces a field the
call site set.

`telemetryTransport()` sends winston's lines wherever the telemetry's exporters
go, with no call site changed. `winstonExporter()` goes the other way, for an
application whose log shipping is already solved. Spans are off by default —
a span is a duration and a set of attributes, and turning every one into a line
is how a cheap trace becomes an expensive log bill — and a failed span is
written at `error` whatever `spanSeverity` says.

**Both halves on the same logger is a loop**, and a loop here does not crash: it
spins. `winstonExporter` refuses that wiring at construction when it can see it,
and every line this library writes into winston carries a mark the transport
drops — which catches the shapes construction cannot see, such as two loggers
pointing at each other.

`winston` is an **optional** peer and nothing here imports it: the format is a
plain object with `transform`, and the transport extends `node:stream`'s
`Writable`, which is what `winston-transport` itself does. The package has no
runtime dependency and installs in a workspace with no winston at all. It also
means the transport does its own level filtering, the same way
`winston-transport` does — on `Symbol.for('level')` and the logger's level
table, learned from Node's `pipe` event — because winston pipes every line to
every transport and expects each to filter.

`@nxgt/shared-logging` needs nothing extra: its `Logger` is winston's own.
