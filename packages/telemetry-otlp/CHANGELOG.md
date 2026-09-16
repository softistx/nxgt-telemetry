# @nxgt/telemetry-otlp

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

- [#4](https://github.com/softistx/nxgt-telemetry/pull/4) [`7f828e6`](https://github.com/softistx/nxgt-telemetry/commit/7f828e6fa1f4378e472d83b58ef6fc19066a2766) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `@nxgt/telemetry-otlp`: logs and traces to any OpenTelemetry collector, as
  OTLP/HTTP JSON over `fetch`.
  
  ```ts
  createTelemetry('checkout', {
    exporters: [otlpExporter({ endpoint: 'http://localhost:4318' })],
  }).install();
  ```
  
  There is no OpenTelemetry SDK behind it. OTLP is a wire format, and the whole of
  it a collector needs is two JSON documents over HTTP — which is what gives this
  package one dependency and no transitive tree, and what keeps the context in
  `AsyncLocalStorage` rather than in the Java SDK's thread-local shape.
  
  A mixed batch is **two requests**, sent together: logs failing must not cost the
  traces of the same batch. `408`, `429` and the five `5xx` the specification
  names are retried with a doubling backoff and reported as `OtlpRefusedError`;
  anything else is `OtlpRejectedError` and is **not** retried, because the same
  bytes would get the same answer; no answer at all is `OtlpUnreachableError`. A
  `partialSuccess` reaches `onPartialSuccess` and is not retried either — the
  collector already accepted everything else.
  
  A whole number crosses as an `intValue` only inside the safe range: past it,
  `String` switches to exponential notation and the digits stop being the number
  that was meant, and a collector answers `400` — which is not retried, so one
  attribute would lose the whole document. Past the safe range it is a
  `doubleValue`, which is all the precision the value had anyway.
  
  A failure reports the request URL with its userinfo, query string and fragment
  removed: a vendor's collector URL carries its key in one of those often enough
  that a failure must not be the thing that logs it.
  
  The conversion is exported on its own — `logsRequest`, `tracesRequest`,
  `otlpResource`, `anyValue`, `nanos` — so another transport can reuse it.
  Instants go through `BigInt`: `Date.now() * 1e6` passed
  `Number.MAX_SAFE_INTEGER` in 2001, and the float path answers the same
  timestamp for two signals a microsecond apart.

### Patch Changes

- Updated dependencies [[`ac5e971`](https://github.com/softistx/nxgt-telemetry/commit/ac5e971a90f107259ffef5cd21a2f5e7a1ae6593), [`e1132e5`](https://github.com/softistx/nxgt-telemetry/commit/e1132e5566711fe7637893fac7c382e82dab720a), [`43bcd01`](https://github.com/softistx/nxgt-telemetry/commit/43bcd01665111c1638cc2481d6a34f3075c090f4), [`4fb6bd0`](https://github.com/softistx/nxgt-telemetry/commit/4fb6bd06d848df102cab312241661e4bde6834f8), [`a48048e`](https://github.com/softistx/nxgt-telemetry/commit/a48048ece10a02f3b62042f2640743301cadb415)]:
  - @nxgt/telemetry@0.2.0
