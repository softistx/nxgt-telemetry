# @nxgt/telemetry-httpyz

## 0.2.0

### Minor Changes

- [#6](https://github.com/softistx/nxgt-telemetry/pull/6) [`d15ec3d`](https://github.com/softistx/nxgt-telemetry/commit/d15ec3df07a59f30dd9840d3ec7e6ac4e960dbf6) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `@nxgt/telemetry-httpyz`: one client span per `@nxgt/httpyz` request, with
  the current `traceparent` on the way out.
  
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
  
  Per *request*, not per call: `retry` and `auth` sit outside the middlewares in
  httpyz, so a retried call and one replayed after a token refresh each open a
  fresh span — three attempts are three spans under one parent, which is what a
  trace should show. A failure raised *after* the reply arrives — a
  `ValidationError`, an `UndeclaredStatusError` — happens outside the middleware
  chain and is not on the span.
  
  `url.template` carries the path template, which is the OTel convention for
  grouping calls that differ only by their parameters. `http.operation` carries an
  OpenAPI `operationId`; there is no convention for that one, so it is an
  **addition to the vocabulary** this estate shares with `stx-telemetry`, and its
  ktor module should use the same name.
  
  With no telemetry anywhere, **no header is sent**: a detached scope's
  `traceparent()` is all zeros, which W3C calls invalid, and sending it is worse
  than sending nothing. Only the types of `@nxgt/httpyz` are used, so this package
  has no runtime dependency on the client at all.

### Patch Changes

- Updated dependencies [[`ac5e971`](https://github.com/softistx/nxgt-telemetry/commit/ac5e971a90f107259ffef5cd21a2f5e7a1ae6593), [`e1132e5`](https://github.com/softistx/nxgt-telemetry/commit/e1132e5566711fe7637893fac7c382e82dab720a), [`43bcd01`](https://github.com/softistx/nxgt-telemetry/commit/43bcd01665111c1638cc2481d6a34f3075c090f4), [`4fb6bd0`](https://github.com/softistx/nxgt-telemetry/commit/4fb6bd06d848df102cab312241661e4bde6834f8), [`a48048e`](https://github.com/softistx/nxgt-telemetry/commit/a48048ece10a02f3b62042f2640743301cadb415)]:
  - @nxgt/telemetry@0.2.0
