# nxgt-telemetry

Logs and traces for a TypeScript service, without an OpenTelemetry SDK.

| Package | | |
| --- | --- | --- |
| [`@nxgt/telemetry`](packages/telemetry) | the core: `createTelemetry`, `span`, `continuing`, a logger whose events are declared rather than stringified, W3C `traceparent` propagation over `AsyncLocalStorage`, sampling decided once by the root, and a pipeline that never blocks the caller. No runtime dependency | [npm](https://www.npmjs.com/package/@nxgt/telemetry) |
| [`@nxgt/telemetry-otlp`](packages/telemetry-otlp) | an OTLP/HTTP exporter, JSON over `fetch`, with retry and gzip. Any collector that speaks OTLP takes it | [npm](https://www.npmjs.com/package/@nxgt/telemetry-otlp) |
| [`@nxgt/telemetry-hono`](packages/telemetry-hono) | a Hono middleware: one span per request, wrapping the handler, `traceparent` in and out, `http.route` after routing | [npm](https://www.npmjs.com/package/@nxgt/telemetry-hono) |
| [`@nxgt/telemetry-httpyz`](packages/telemetry-httpyz) | the other half: a client span per outgoing call, with the current `traceparent` injected | [npm](https://www.npmjs.com/package/@nxgt/telemetry-httpyz) |
| [`@nxgt/telemetry-mongo`](packages/telemetry-mongo) | signals stored in MongoDB behind a TTL index, and command-level spans from the driver's own monitoring | [npm](https://www.npmjs.com/package/@nxgt/telemetry-mongo) |
| [`@nxgt/telemetry-logging`](packages/telemetry-logging) | the winston bridge, in both directions: existing log lines gain `traceId`, or telemetry is written through a winston you already have | [npm](https://www.npmjs.com/package/@nxgt/telemetry-logging) |

Each package's README, its npm page, shows how to use it, then documents every
function, class and type it exports in its **API** section.

New to tracing, or to this library's words for it? The
[**Concepts**](packages/telemetry/README.md#concepts) section of the core README
defines each one — telemetry, resource, signal, trace, span, span context,
propagation, context, attributes and their inheritance, severity, declared
events, sampling, exporters, the pipeline — with a short example for each.

## Usage

A Hono service that exports to an OpenTelemetry collector, calls another
service, reads MongoDB and keeps its existing winston logger:

```sh
bun add @nxgt/telemetry @nxgt/telemetry-otlp @nxgt/telemetry-hono \
  @nxgt/telemetry-httpyz @nxgt/telemetry-mongo @nxgt/telemetry-logging
```

```ts
import { createHttpClient } from '@nxgt/httpyz';
import { createLogger } from '@nxgt/telemetry';
import { telemetry } from '@nxgt/telemetry-hono';
import { tracing } from '@nxgt/telemetry-httpyz';
import { telemetryFormat } from '@nxgt/telemetry-logging';
import { instrumentMongo } from '@nxgt/telemetry-mongo';
import { otlpExporter } from '@nxgt/telemetry-otlp';
import { Hono } from 'hono';
import { MongoClient } from 'mongodb';
import winston from 'winston';

// 1. one telemetry for the process, built by the middleware
const traced = telemetry({
  service: 'checkout',
  version: '1.4.0',
  exporters: [otlpExporter({ endpoint: 'http://localhost:4318' })],
  traced: (c) => c.req.path !== '/health',
});

// 2. the existing winston lines gain traceId and spanId
const logger = winston.createLogger({
  format: winston.format.combine(telemetryFormat(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

// 3. a span per Mongo command, a span and a traceparent per outgoing call
const mongo = new MongoClient(process.env.MONGO_URL!, { monitorCommands: true });
instrumentMongo(mongo);
const stock = createHttpClient({ baseUrl: 'http://stock.internal', use: [tracing()] });

const log = createLogger('CheckoutRoutes');
const app = new Hono();
app.use('*', traced);

app.post('/orders/:id/checkout', async (c) => {
  const id = c.req.param('id');
  const order = await mongo.db().collection('orders').findOne({ id });   // child span
  await stock.post('/reservations', { json: { id } });                   // child span, traceparent sent
  log.info('order checked out', { id });                                 // carries the trace
  logger.info('checkout done', { id });                                  // so does winston
  return c.json(order);
});

// 4. the last batch is the one that explains the shutdown: await it
process.on('SIGTERM', async () => {
  await traced.telemetry.close();
  process.exit(0);
});

export default app;
```

One request gives one trace: the server span, a client span for the Mongo
query, and a client span for the call to `stock`. If `stock` runs the same
middleware, its server span joins the same trace. Every log line from the
handler carries that trace's id.

Outside a web framework, the core does the same by hand: see
[**Usage**](packages/telemetry/README.md#usage) in the core README, a
step-by-step walk from `createTelemetry` to `close`, with a recipe for tests.

## How they fit

```
                    @nxgt/telemetry
                          │
   ┌──────────┬───────────┼───────────┬──────────────┐
   │          │           │           │              │
  -otlp     -hono      -httpyz      -mongo       -logging
 collector  server      client     storage +      winston
            spans       spans     driver spans     bridge
```

`@nxgt/telemetry` depends on nothing. Every integration depends on the core by
`workspace:^` and on its own host — `hono`, `@nxgt/httpyz`, `mongodb`,
`winston` — as an **optional** peer, so installing one never drags in a library
you do not use.

## Development

Bun 1.4.2.

```sh
bun install
bun run build        # first: exports point at dist/
bun run typecheck
bun run test
bun run verify:artifacts
./node_modules/.bin/biome check --write
```

A change under `packages/` needs a changeset (`bun changeset`). Merging to
`develop` opens a "Version packages" PR, and merging that PR publishes.
[AGENTS.md](AGENTS.md) explains why each of these steps exists.

## License

[MIT](LICENSE), for every package.
