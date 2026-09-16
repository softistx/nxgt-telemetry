---
'@nxgt/telemetry': minor
---

Add `span`, `continuing` and the logger — the two verbs that produce signals.

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
