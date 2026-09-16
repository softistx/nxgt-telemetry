---
'@nxgt/telemetry-hono': minor
---

Add `@nxgt/telemetry-hono`: one server span per Hono request, around the whole
handler.

```ts
const tracing = telemetry({ service: 'checkout', exporters: [otlpExporter({ endpoint })] });
app.use('*', tracing);
```

It is one middleware around `next()` rather than a pair of before/after hooks,
which is what puts the whole handler — everything it awaits, and everything it
throws — inside the span's context: a `log.info()` three calls down carries the
request's `traceId` without anything having been passed to it.

An inbound `traceparent` continues that trace; an unusable one starts a fresh
one, because the header came from a stranger. The span is renamed to
`"<METHOD> <route>"` once the router has matched, so a dashboard gets one row
per route instead of one per order id, and the path stays as `url.path`. A 4xx
is `ok` and only a 5xx marks the span. Hono catches a handler's exception and
leaves it on `c.error`, so the middleware reads it there — otherwise the span
would carry a status and no `exception.type`.

`traced` is the health-check hook and skips nothing by default.
`c.get('span')` and `c.get('telemetry')` are typed in a handler that imports
nothing from this package. A telemetry handed in as `instance` is adopted, not
closed; one built from `service` is installed and comes back on the middleware
as `.telemetry`, for the shutdown hook the application owns.

`hono` is an optional peer from `^4.8.0`, which is where `hono/route` arrived —
`routePath(c, -1)` is how a middleware asks for the handler's registered path.
