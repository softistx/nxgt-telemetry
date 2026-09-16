---
'@nxgt/telemetry': minor
---

Add `SpanScope.fail(failure)`, for recording a failure the span will not see
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
