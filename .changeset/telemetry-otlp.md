---
'@nxgt/telemetry-otlp': minor
---

Add `@nxgt/telemetry-otlp`: logs and traces to any OpenTelemetry collector, as
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
