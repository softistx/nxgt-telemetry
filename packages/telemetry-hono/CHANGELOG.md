# @nxgt/telemetry-hono

## 0.2.1

### Patch Changes

- [#13](https://github.com/softistx/nxgt-telemetry/pull/13) [`1c30c8a`](https://github.com/softistx/nxgt-telemetry/commit/1c30c8a84a9aab5945b3e2ba827a51047a33afb6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Fix the README's opening example, which dropped the promise `close()` returns
  on `SIGTERM` and so could lose the last batch. It now awaits it.

- [#13](https://github.com/softistx/nxgt-telemetry/pull/13) [`8b741c6`](https://github.com/softistx/nxgt-telemetry/commit/8b741c64d50ce5f9db875f6702482d0d3c15c99f) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Depend on `@nxgt/telemetry@^0.2.1`, the core released beside it. 0.2.0 was
  published asking for `^0.1.0`, which in 0.x excludes 0.2.0, so an install
  resolved the 0.1.0 core underneath it rather than the core it was built and
  tested against. Upgrade to this version; do not use 0.2.0.
- Updated dependencies [[`1c30c8a`](https://github.com/softistx/nxgt-telemetry/commit/1c30c8a84a9aab5945b3e2ba827a51047a33afb6)]:
  - @nxgt/telemetry@0.2.1

## 0.2.0

### Minor Changes

- [#5](https://github.com/softistx/nxgt-telemetry/pull/5) [`4fb6bd0`](https://github.com/softistx/nxgt-telemetry/commit/4fb6bd06d848df102cab312241661e4bde6834f8) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `@nxgt/telemetry-hono`: one server span per Hono request, around the whole
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
  
  A thrown `HTTPException` is how a Hono application says `401` — it is what
  `basicAuth`, `bearerAuth`, `jwt` and the validators throw — so the reply decides
  the status and the exception only decides what is recorded. A thrown 4xx stays
  `ok`, with its `exception.type`; an abort answered with a 500 stays `cancelled`.
  
  The route is the last matched **handler**, not the last matched route: a
  middleware takes `(c, next)` and a handler takes `(c)`, which is how hono's own
  `matchedRoutes` example tells them apart. Taking the last match would name the
  span after a middleware registered after the routes, and would report a mount's
  catch-all as the route of a 404.
  
  `server.address` is the host **without** the port, and `server.port` carries it
  separately — the OTel convention, and what `@nxgt/telemetry-httpyz` records on
  the other side of the wire, so a server span and the client span that called it
  agree about a name every HTTP dashboard groups by.
  
  `hono` is an optional peer from `^4.8.0`, which is where `hono/route` arrived.
  `matchedRoutes(c)` has been the same one-argument function ever since;
  `routePath(c, -1)` would have been the obvious call and takes a second argument
  only from hono 4.10, so on 4.8 and 4.9 the `-1` is silently ignored.

### Patch Changes

- Updated dependencies [[`ac5e971`](https://github.com/softistx/nxgt-telemetry/commit/ac5e971a90f107259ffef5cd21a2f5e7a1ae6593), [`e1132e5`](https://github.com/softistx/nxgt-telemetry/commit/e1132e5566711fe7637893fac7c382e82dab720a), [`43bcd01`](https://github.com/softistx/nxgt-telemetry/commit/43bcd01665111c1638cc2481d6a34f3075c090f4), [`4fb6bd0`](https://github.com/softistx/nxgt-telemetry/commit/4fb6bd06d848df102cab312241661e4bde6834f8), [`a48048e`](https://github.com/softistx/nxgt-telemetry/commit/a48048ece10a02f3b62042f2640743301cadb415)]:
  - @nxgt/telemetry@0.2.0
