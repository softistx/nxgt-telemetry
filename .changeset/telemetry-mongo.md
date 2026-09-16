---
'@nxgt/telemetry-mongo': minor
---

Add `@nxgt/telemetry-mongo`: MongoDB in both directions — an exporter that
stores signals in a collection, and client spans for every command the driver
sends.

```ts
createTelemetry('checkout', { exporters: [mongoExporter({ db })] }).install();

const client = new MongoClient(uri, { monitorCommands: true });
const stop = instrumentMongo(client);
```

**The exporter** writes one document per signal, and the documents *are* the
signals — `db.telemetry.find({ traceId })` is the whole query language. Three
things change on the way in and nothing else: every instant becomes a BSON
`Date`, the resource is stamped on each document (a collection here is shared by
every service that writes to it, which is the opposite of a log file), and `at`
exists on both kinds so one index covers logs and spans alike.

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
