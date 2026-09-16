# @nxgt/telemetry-hono

One server span per Hono request, around the whole handler — with the inbound
`traceparent` continued, the route as the span name, and everything the handler
logs carrying the request's trace id.

```sh
bun add @nxgt/telemetry @nxgt/telemetry-hono hono
```

```ts
import { Hono } from 'hono';
import { telemetry } from '@nxgt/telemetry-hono';
import { otlpExporter } from '@nxgt/telemetry-otlp';

const tracing = telemetry({
  service: 'checkout',
  version: '1.4.0',
  exporters: [otlpExporter({ endpoint: 'http://localhost:4318' })],
});

const app = new Hono();
app.use('*', tracing);

app.get('/orders/:id', async (c) => {
  log.info('order read', { id: c.req.param('id') });   // carries this request's traceId
  return c.json(await orders.find(c.req.param('id')));
});

process.on('SIGTERM', () => void tracing.telemetry.close());
```

## The span wraps the handler

It is one middleware around `next()`, not a pair of before/after hooks. That is
what puts the whole handler — everything it awaits, and everything it throws —
inside the span's context, so a `log.info()` three calls down carries this
request's `traceId` without anything having been passed to it.

A `traceparent` on the way in continues that trace, as a child of the caller's
span. An unusable header is **not** an error: it starts a fresh trace, because
the header came from a stranger.

## The name is the route, and routing knows it last

The span starts as `"<METHOD> <path>"` and is renamed to `"<METHOD> <route>"`
once the router has matched — `GET /orders/:id`, not `GET /orders/o-1`. A span
named for the path it arrived at gives a dashboard one row per order id. The
path is still there, as `url.path`.

A request that matched nothing keeps the path in its name and gets no
`http.route`: there is no route to report.

## What it records

| attribute | |
| --- | --- |
| `http.request.method` | before the handler runs |
| `url.path`, `url.scheme`, `server.address` | the request as it arrived |
| `http.route` | after routing, when something matched |
| `http.response.status_code` | after the handler |

**A 4xx is `ok`.** The client sent something the server refused, which is the
server working; counting it as an error is what makes an error rate nobody can
act on. Only `5xx` marks the span.

**Hono catches.** A handler that throws does not reject `next()` — the router
turns the exception into a `500` and leaves the failure on `c.error`. This
middleware reads it, so the span carries `exception.type` and not just a status.

## Options

```ts
telemetry({ service: 'checkout', exporters: [...] })   // builds one, and installs it
telemetry({ instance })                                // adopts one; never closes it
```

The two shapes are exclusive, and the compiler says so: `service` beside an
`instance` would be silently ignored.

| | default | |
| --- | --- | --- |
| `service` | — | the service name, plus every `createTelemetry` option |
| `instance` | — | an existing telemetry. **Adopted, not closed** |
| `traced` | everything | whether a request gets a span at all |
| `spanName` | `"<METHOD> <path>"` | the name before routing |
| `route` | `routePath(c, -1)` | the route template, after the handler |

`traced` is the health-check hook:

```ts
telemetry({ service: 'checkout', traced: (c) => c.req.path !== '/health' })
```

Nothing is skipped by default. A library that decides for you which requests do
not matter is a library that hides the one that did.

## Closing it

A middleware has no shutdown to hook, so it does not close anything. The
telemetry it is using comes back on the middleware itself:

```ts
const tracing = telemetry({ service: 'checkout', exporters: [...] });
process.on('SIGTERM', async () => {
  await tracing.telemetry.close();   // has to be awaited: the last batch is the one that explains the shutdown
  process.exit(0);
});
```

## From the handler

```ts
app.get('/orders/:id', (c) => {
  c.get('span')?.attribute('tenant', tenant);
  c.get('span')?.event('cache.missed');
  c.get('telemetry');                         // the one this request is written to
  return c.json(order);
});
```

Importing anything from this package augments Hono's `ContextVariableMap`, so
both are typed in a handler that imports nothing from here. `c.get('span')` is
`undefined` when `traced` said no.

## API

| | |
| --- | --- |
| `telemetry(options)` | the middleware, with `.telemetry` on it |
| `TelemetryMiddlewareOptions` | the two shapes above |
| `TelemetryMiddleware` | a `MiddlewareHandler` carrying its `Telemetry` |
| `requestAttributes(request)` | what is known before the handler runs |
| `serverFailed(status)` | whether a status marks the span |
| `HTTP_METHOD`, `URL_PATH`, `URL_SCHEME`, `HTTP_ROUTE`, `HTTP_STATUS`, `SERVER_ADDRESS` | the attribute names |
| `SERVER_ERROR_FROM` | `500` |
| `TELEMETRY_VARIABLE`, `SPAN_VARIABLE` | the context keys, as values |

## Traps

- **`hono` is an optional peer, from `^4.8.0`.** The floor is where `hono/route`
  arrived: `routePath(c, -1)` is how a middleware asks for the *handler's*
  registered path, and `c.req.routePath` — which is deprecated — would answer
  this middleware's own pattern.
- **`routePath(c)` without the `-1` answers `*`.** From inside a middleware the
  current route is the middleware's own pattern. That is why the default hook
  passes `-1`, and why a `route` hook you write yourself should too.
- **The telemetry built from `service` is installed**, so a log written outside
  any request finds it. An adopted `instance` is left exactly as it was.
- **`close()` is not called for you**, and it has to be awaited. A
  `process.exit()` before it resolves loses the last batch.
- **A 4xx is `ok`, a 5xx is not.** If your API answers `200` with an error body,
  set `c.get('span')!.status = 'error'` yourself — nothing here can know.
- **`traced: false` means no context either.** `c.get('span')` is `undefined`,
  and a log written in that handler carries no trace id.

## License

MIT
