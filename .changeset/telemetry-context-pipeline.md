---
'@nxgt/telemetry': minor
---

Add the telemetry root, the context and the export pipeline.

`createTelemetry(service, options)` builds a telemetry from its resource, its
sampler and its exporters; `install()` makes it the one a logger or a span finds
with nothing in scope, and `close()` — which must be awaited — ships the backlog
and closes the exporters. `drainTimeout` bounds the whole of it, the exporters'
own `close` included, so neither a collector that stopped answering nor an
exporter that will not let go of its socket can keep a process alive.

The current span and the inherited attributes travel in an `AsyncLocalStorage`,
so they survive any number of `await`s, reach everything started inside a span,
and never leak into a sibling task. `withAttributes` at the top level of an
application, before any span, opens a context from the installed telemetry
rather than dropping what it was given. `withTelemetry`, `withAttributes`,
`currentSpan` and `currentTraceparent` are the verbs; a telemetry in scope beats
the installed default.

`Exporter` is one function over a batch, called from a single consumer that
never runs two exports at once. Writing a signal is synchronous and total: the
queue is unbounded, an exporter that throws is reported and the next one still
receives the batch, and a signal written after `close()` is dropped rather than
raised. `consoleExporter()` is the first exporter.
