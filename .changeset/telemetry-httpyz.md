---
'@nxgt/telemetry-httpyz': minor
---

Add `@nxgt/telemetry-httpyz`: one client span per `@nxgt/httpyz` call, with the
current `traceparent` on the way out.

```ts
const api = createHttpClient({ baseUrl, use: [tracing()] });
```

Inside a server span this is the half that makes a trace a trace: the outgoing
request carries the header that lets the service on the other end continue it,
taken from whatever span is open **now** rather than from anything passed to the
call site. Outside any span the call still goes out and nothing is emitted.

**A client span fails at `400`, not at `500`.** A `404` answered by a server is
that server working, and `@nxgt/telemetry-hono` records it as `ok`; the same
`404` received by a caller is a call that did not do what it was for. Both
readings are correct, and each belongs to the span on its own side of the wire.
A timeout is `cancelled` either way.

The span is named for the `operationId` when the call has one and
`"<METHOD> <path>"` otherwise — the template the caller wrote, which httpyz
hands over already, so there is no cardinality problem to solve. `url.full` has
its userinfo removed, and a `url` hook replaces it for a query string that
carries a key.

With no telemetry anywhere, **no header is sent**: a detached scope's
`traceparent()` is all zeros, which W3C calls invalid, and sending it is worse
than sending nothing. Only the types of `@nxgt/httpyz` are used, so this package
has no runtime dependency on the client at all.
