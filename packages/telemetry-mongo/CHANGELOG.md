# @nxgt/telemetry-mongo

## 0.2.0

### Minor Changes

- [#7](https://github.com/softistx/nxgt-telemetry/pull/7) [`aedfac0`](https://github.com/softistx/nxgt-telemetry/commit/aedfac0bf171d69756d995534e61068ba5417a51) Thanks [@SteveGT96](https://github.com/SteveGT96)! - Add `@nxgt/telemetry-mongo`: MongoDB in both directions — an exporter that
  stores signals in a collection, and client spans for every command the driver
  sends.
  
  ```ts
  createTelemetry('checkout', { exporters: [mongoExporter({ db })] }).install();
  
  const client = new MongoClient(uri, { monitorCommands: true });
  const stop = instrumentMongo(client);
  ```
  
  **The exporter** writes one document per signal, and the documents *are* the
  signals — `db.telemetry.find({ traceId })` is the whole query language. Four
  things change on the way in and nothing else: every instant becomes a BSON
  `Date`; the resource is stamped on each document, attributes included, because a
  collection here is shared by every service that writes to it, which is the
  opposite of a log file; `traceId` and `spanId` are lifted to the top level, out
  of `span` on a log and `context` on a span, so that query is one field and one
  index rather than an `$or` over two paths; and `at` exists on both kinds so one
  index covers logs and spans alike.
  
  A dotted attribute name is stored as a key, not a path, so reaching
  `db.system.name` inside `attributes` needs `$getField` — the fields worth
  querying (`traceId`, `at`, `service`, `status`) are top-level for that reason.
  
  A connection that fails is not cached — Mongo is routinely not up yet when a
  process boots, and a rejected promise kept in that slot would make every later
  batch replay the same failure for the life of the process.
  
  Retention is a TTL index, 30 days by default, created on the first batch and
  **recreated when the value changes** — Mongo answers `IndexOptionsConflict`
  rather than adopting a new `expireAfterSeconds`. `retention: false` keeps
  everything and removes an index an earlier configuration left behind. A `db` you
  pass is never closed; the `uri` form opens its own pool so a burst of telemetry
  cannot starve your application's queries.
  
  **The instrumentation** listens to the driver's public command monitoring, so
  nothing is patched — which is what makes it work under Bun, where
  `require-in-the-middle` does not. `monitorCommands: true` is required and cannot
  be turned on from here; without it the driver emits nothing and this is silently
  inert. Mongoose reaches its client through `mongoose.connection.getClient()`.
  
  Spans carry `db.system.name`, `db.namespace`, `db.collection.name`,
  `db.operation.name`, `server.address` and `server.port`, and are named
  `"<command> <collection>"`. Nothing else from the command document is read: a
  command document holds the query, and a query holds the data. The driver's own
  commands — handshake, heartbeat, authentication, session cleanup — are skipped
  by default, the one place in this library where anything is.
  
  Sampling is read from the parent and never taken again per command, so an
  unsampled trace stays unsampled all the way down and an unsampled service pays
  nothing for the instrumentation. A command that neither succeeds nor fails is
  forgotten once `MAX_IN_FLIGHT` others are in flight, because a connection
  dropped between the two events would otherwise be remembered for ever.
  
  `mongodb` is an **optional** peer and is imported lazily, so the package
  installs in an application that has no driver at all.

### Patch Changes

- Updated dependencies [[`ac5e971`](https://github.com/softistx/nxgt-telemetry/commit/ac5e971a90f107259ffef5cd21a2f5e7a1ae6593), [`e1132e5`](https://github.com/softistx/nxgt-telemetry/commit/e1132e5566711fe7637893fac7c382e82dab720a), [`43bcd01`](https://github.com/softistx/nxgt-telemetry/commit/43bcd01665111c1638cc2481d6a34f3075c090f4), [`4fb6bd0`](https://github.com/softistx/nxgt-telemetry/commit/4fb6bd06d848df102cab312241661e4bde6834f8), [`a48048e`](https://github.com/softistx/nxgt-telemetry/commit/a48048ece10a02f3b62042f2640743301cadb415)]:
  - @nxgt/telemetry@0.2.0
