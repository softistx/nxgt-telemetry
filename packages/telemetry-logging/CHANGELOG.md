# @nxgt/telemetry-logging

## 0.2.1

### Patch Changes

- [#13](https://github.com/softistx/nxgt-telemetry/pull/13) [`8b741c6`](https://github.com/softistx/nxgt-telemetry/commit/8b741c64d50ce5f9db875f6702482d0d3c15c99f) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Depend on `@nxgt/telemetry@^0.2.1`, the core released beside it. 0.2.0 was
  published asking for `^0.1.0`, which in 0.x excludes 0.2.0, so an install
  resolved the 0.1.0 core underneath it rather than the core it was built and
  tested against. Upgrade to this version; do not use 0.2.0.
- Updated dependencies [[`1c30c8a`](https://github.com/softistx/nxgt-telemetry/commit/1c30c8a84a9aab5945b3e2ba827a51047a33afb6)]:
  - @nxgt/telemetry@0.2.1

## 0.2.0

### Minor Changes

- [#8](https://github.com/softistx/nxgt-telemetry/pull/8) [`5038c20`](https://github.com/softistx/nxgt-telemetry/commit/5038c204c2b1f3a5082865faf56feff6cfac6e39) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `@nxgt/telemetry-logging`: the winston bridge, in both directions.
  
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
  means the transport does its own level filtering, the way `winston-transport`
  does — on `Symbol.for('level')` and the logger's level table, learned from
  Node's `pipe` event — because winston pipes every line to every transport and
  expects each to filter. A spec runs both on the same logger and asserts they
  keep the same lines. The one deliberate difference: a line at a level the
  logger's table does not know is kept here and dropped there, for the same reason
  an unknown level maps to `info` rather than `debug`.
  
  A winston line clears the telemetry's `minimum` as well as winston's own level,
  an `Error` on the line becomes the record's `ErrorInfo` — so it reaches OTLP as
  `exception.type` rather than as text on an attribute — and the attributes in
  scope come along under whatever the line already carried, which is the
  inheritance rule the rest of the library follows. A line from winston's
  `exceptionHandlers` is skipped unless `handleExceptions` asks for it, because
  opting in makes winston wait on this transport before the process exits.
  
  `@nxgt/shared-logging` needs nothing extra: its `Logger` is winston's own.

### Patch Changes

- Updated dependencies [[`ac5e971`](https://github.com/softistx/nxgt-telemetry/commit/ac5e971a90f107259ffef5cd21a2f5e7a1ae6593), [`e1132e5`](https://github.com/softistx/nxgt-telemetry/commit/e1132e5566711fe7637893fac7c382e82dab720a), [`43bcd01`](https://github.com/softistx/nxgt-telemetry/commit/43bcd01665111c1638cc2481d6a34f3075c090f4), [`4fb6bd0`](https://github.com/softistx/nxgt-telemetry/commit/4fb6bd06d848df102cab312241661e4bde6834f8), [`a48048e`](https://github.com/softistx/nxgt-telemetry/commit/a48048ece10a02f3b62042f2640743301cadb415)]:
  - @nxgt/telemetry@0.2.0
