# @nxgt/telemetry-httpyz

One client span per [`@nxgt/httpyz`](https://www.npmjs.com/package/@nxgt/httpyz)
call, with the current `traceparent` on the way out — which is the half that
makes a trace a trace.

```sh
bun add @nxgt/telemetry @nxgt/telemetry-httpyz @nxgt/httpyz
```

```ts
import { createHttpClient } from '@nxgt/httpyz';
import { tracing } from '@nxgt/telemetry-httpyz';

const api = createHttpClient({
  baseUrl: 'https://api.example',
  use: [tracing()],
});
```

That is all of it. Inside a server span — from `@nxgt/telemetry-hono`, or from
any `span()` — the outgoing request carries the header that lets the service on
the other end continue the same trace, and the client span becomes a child of
whatever is open **now**. Nothing has to be passed down to the call site.

## What it records

| attribute | |
| --- | --- |
| `http.request.method` | uppercased, whatever the caller wrote |
| `url.full` | the URL, **without its userinfo** |
| `server.address`, `server.port` | the port only when there is one |
| `http.operation` | the `operationId`, when the call has one |
| `http.response.status_code` | after the reply |

The span is named for the `operationId` when there is one, and
`"<METHOD> <path>"` otherwise — where the path is the template the caller wrote,
`/employees/{id}`, not the one it filled in. There is no cardinality problem to
solve here: httpyz hands over the template already.

## A client span fails at 400, not at 500

This is where a client span and a server span disagree, and the asymmetry is the
point. A `404` answered by a server is that server working — `@nxgt/telemetry-hono`
records it as `ok`. The same `404` received by a caller is a call that did not do
what it was for, and this records it as an error. Both readings are correct, and
each belongs to the span on its own side of the wire.

A timeout is neither: `cancelled`, because a dashboard that counts timeouts as
failures is a dashboard nobody trusts.

## Options

| | default | |
| --- | --- | --- |
| `traced` | everything | whether a call gets a span at all |
| `spanName` | the `operationId`, else `"<METHOD> <path>"` | |
| `url` | the URL without its userinfo | return `undefined` to record none |

```ts
tracing({
  traced: (call) => call.path !== '/health',
  url: (request) => new URL(request.url).origin,   // a query string that carries a key
})
```

Nothing is skipped by default, and a hook that throws costs its own answer and
nothing else: `traced` falls back to tracing, `spanName` to the default name,
`url` to recording none. A predicate that raises must not turn observability
into a failed call.

## API

| | |
| --- | --- |
| `tracing(options)` | the middleware |
| `TracingOptions` | the options above |
| `TRACEPARENT` | `'traceparent'` |
| `callAttributes(request, method)` | what is known before the call is sent |
| `callFailed(status)`, `CLIENT_ERROR_FROM` | the 400 rule |
| `safeUrl(url)` | a `URL` with its credentials removed, or `undefined` |
| `method(call)` | the call's method, uppercased |
| `HTTP_METHOD`, `URL_FULL`, `SERVER_ADDRESS`, `SERVER_PORT`, `HTTP_STATUS`, `OPERATION` | the attribute names |

## Traps

- **With no telemetry anywhere, no header is sent.** A detached scope's
  `traceparent()` is all zeros, which this library's own parser rejects and
  which W3C calls invalid; sending it is worse than sending nothing, because a
  strict receiver refuses the request and a lenient one starts a fresh trace
  exactly as an absent header would. The call still goes out.
- **An existing `traceparent` on the request is replaced.** The header describes
  the call being made now. A stale one — copied from an inbound request, say —
  would attach this call to a span that has already ended.
- **`@nxgt/httpyz` is an optional peer, and only its types are used.** Nothing
  here imports a value from it, so this package has no runtime dependency on the
  client at all.
- **The span ends when the `Response` is returned, not when its body is read.**
  A streamed reply is recorded as the time it took to *start*.
- **`url.full` keeps the query string.** It is usually what tells one call from
  another. If yours carries a key, pass a `url` hook — the userinfo is stripped
  for you, the query is not.
- **A retry is one span, not two.** httpyz's `retry` sits outside the
  middlewares, so a retried call opens a fresh span each attempt; a middleware
  cannot see that it is the second one.

## License

MIT
