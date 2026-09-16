# @nxgt/telemetry-mongo

MongoDB for [`@nxgt/telemetry`](https://www.npmjs.com/package/@nxgt/telemetry),
two ways round: an **exporter** that stores signals in a collection, and an
**instrumentation** that turns every command the driver sends into a client
span.

```sh
bun add @nxgt/telemetry @nxgt/telemetry-mongo mongodb
```

The two are independent. Take the exporter if you already run Mongo and do not
want a collector; take the instrumentation whatever you export to.

## The exporter

```ts
import { createTelemetry } from '@nxgt/telemetry';
import { mongoExporter } from '@nxgt/telemetry-mongo';

createTelemetry('checkout', {
  exporters: [mongoExporter({ db })],
}).install();
```

One document per signal, in `telemetry`. The documents **are** the signals, so
there is no query language to learn:

```js
db.telemetry.find({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736' }).sort({ at: 1 })
db.telemetry.find({ type: 'span', status: 'error', at: { $gte: ISODate('…') } })
```

Four things are changed on the way in, and nothing else:

| | |
| --- | --- |
| every instant | a BSON `Date` — an epoch number is neither a range nor expirable |
| the resource | stamped on each document: `service`, `version`, `environment`, and its attributes under `resource` |
| `traceId`, `spanId` | lifted to the top level — they live at `span.traceId` on a log and `context.traceId` on a span, so the query above would otherwise need an `$or` over two paths and an index on each |
| `at` | on **both** kinds. A span carries its start, so one index covers both |

The last one is why a TTL index works at all, and the second is why it is worth
it: a collection here is shared by every service that writes to it, which is the
opposite of a log file.

### Retention is an index

```ts
mongoExporter({ db, retention: 7 * 24 * 60 * 60 * 1000 })  // a week
mongoExporter({ db, retention: false })                    // keep everything
```

Default 30 days. The TTL index is created on the first batch and **recreated
when the value changes** — Mongo answers `IndexOptionsConflict` rather than
adopting a new `expireAfterSeconds`, so changing it means dropping and making
it again. The index has a fixed name, `nxgt_telemetry_retention`, which is what
makes it recognisable; nothing else should use that name. `retention: false`
removes an index an earlier configuration left behind.

### Its own pool, or yours

```ts
mongoExporter({ db })                                   // yours
mongoExporter({ uri: 'mongodb://…', database: 'obs' })  // its own
```

The compiler refuses both at once. A `db` you pass is **never closed** — it is
yours, and this is one of several things using it. The `uri` form opens its own
pool and closes it on `close()`, so a burst of telemetry cannot starve the
connections your application's queries need.

## The instrumentation

```ts
import { MongoClient } from 'mongodb';
import { instrumentMongo } from '@nxgt/telemetry-mongo';

const client = new MongoClient(uri, { monitorCommands: true });
const stop = instrumentMongo(client);
```

**`monitorCommands: true` is required**, and cannot be turned on from here: it
is a connection option, read when the client is built. Without it the driver
emits nothing and this is silently inert. It is the first thing to check when
no spans appear.

It listens to the driver's **public** command monitoring. Nothing is patched,
which is what makes it work under Bun — `require-in-the-middle`, what the
OpenTelemetry auto-instrumentations hook with, does not.

With mongoose, reach the client through the connection:

```ts
instrumentMongo(mongoose.connection.getClient());
// mongoose.connect(uri, { monitorCommands: true })
```

### What it records

| attribute | |
| --- | --- |
| `db.system.name` | `mongodb` |
| `db.namespace` | the database |
| `db.collection.name` | when the command names one |
| `db.operation.name` | `find`, `insert`, `aggregate`, … |
| `server.address`, `server.port` | the node that answered |

The span is named `"<command> <collection>"`, or the database when the command
is not about a collection. Its kind is `client`; a failure is `error`, an abort
is `cancelled`.

**Nothing from the command document is read** beyond the collection name. A
command document holds the query, and a query holds the data.

### Options

```ts
instrumentMongo(client, {
  traced: (event) => event.databaseName !== 'admin',
  spanName: (event) => `mongo ${event.commandName}`,
  telemetry,                    // default: in scope, else installed
})
```

`traced` defaults to everything except the driver's own commands — the
handshake, the heartbeat, authentication, session cleanup (`DRIVER_COMMANDS`).
It is the one place in this library where something is skipped by default: a
`hello` every ten seconds on every connection is not your work, and a trace
full of them is a trace nobody reads.

`instrumentMongo` returns the function that removes the listeners.

## API

| | |
| --- | --- |
| `mongoExporter(options)`, `MongoExporterOptions` | the exporter |
| `DEFAULT_RETENTION`, `DEFAULT_COLLECTION`, `RETENTION_INDEX` | 30 days, `telemetry`, `nxgt_telemetry_retention` |
| `ensureRetention(db, collection, retention)` | the index, if you want it eagerly |
| `documentOf(resource, signal)`, `SignalDocument` | the stored shape |
| `instrumentMongo(client, options)`, `InstrumentOptions` | the instrumentation |
| `DRIVER_COMMANDS`, `MAX_IN_FLIGHT` | what is skipped, and the in-flight ceiling |
| `commandAttributes(event)`, `commandName(event)` | what a command's span carries, and what it is called |
| `collectionOf(event)`, `splitAddress(address)` | the collection a command is about, and a host and port |
| `DB_SYSTEM`, `DB_NAMESPACE`, `DB_COLLECTION`, `DB_OPERATION`, `SERVER_ADDRESS`, `SERVER_PORT`, `MONGODB` | the attribute names |

## Traps

- **`monitorCommands: true`, or nothing happens.** Said twice on purpose.
- **Do not export telemetry through the pool you are instrumenting.** The
  exporter's own `insertMany` is a command, which becomes a span, which is
  exported… Use a separate client for the exporter — the `uri` form — or
  exclude the telemetry collection with `traced`.
- **`insertMany` is unordered.** One document Mongo refuses — an `_id` holding
  a `$`-prefixed key, a size over the limit — must not cost the 511 behind it.
- **A dotted attribute name is not a path.** Every span here carries keys like
  `db.system.name`, and `find({ 'attributes.db.system.name': 'mongodb' })` reads
  that as a nested path and matches nothing. The document is fine; the query
  needs `$getField`, or `$expr`:
  ```js
  db.telemetry.find({ $expr: { $eq: [{ $getField: { field: 'db.system.name', input: '$attributes' } }, 'mongodb'] } })
  ```
  It is the same for `resource`. `traceId`, `spanId`, `at`, `service` and
  `status` are plain top-level fields precisely because they are the ones
  anybody queries.
- **A first connection that fails is retried on the next batch.** Mongo is
  routinely not up yet when a process boots, so a failed `uri` connection is not
  cached; the batch after it opens a fresh one. Each failure reaches
  `onExportError` and nothing else.
- **The TTL index is checked once per exporter.** An index dropped out of band
  is not rebuilt for the life of the process — the alternative is a round trip
  per batch to catch something nobody does by accident.
- **A span is recorded, not opened.** Monitoring gives a start event and an end
  event, not a block to run inside, so `currentSpan()` inside a query callback
  is still the *caller's* span. The command's parent is whatever was open when
  it started.
- **An unsampled trace is unsampled all the way down.** The decision is read
  from the parent, never taken again per command; a command with nothing above
  it is a root and asks the sampler exactly as `span()` would.
- **A command that neither succeeds nor fails is forgotten** once
  `MAX_IN_FLIGHT` others are in flight. A connection dropped between the two
  events would otherwise be remembered for ever: forgetting it costs one span,
  keeping it costs the process.
- **The duration is the driver's, not the wall clock.** It is closer to what
  the server spent, so the start is derived from the end rather than measured
  across a busy event loop.
- **`mongodb` is an optional peer, and the driver is imported lazily.** Nothing
  loads it until the `uri` form opens a pool, so this package installs in an
  application that has the exporter's sibling and no driver at all.

## License

MIT
