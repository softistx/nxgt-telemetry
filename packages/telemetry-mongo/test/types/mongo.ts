/**
 * Type tests. They are checked by `bun run typecheck` and never run: a call
 * that must not compile carries `@ts-expect-error`, and if it starts compiling
 * tsc fails on the unused directive.
 */

import type { Exporter, Telemetry } from '@nxgt/telemetry';
import type { Db, MongoClient } from 'mongodb';
import type { MongoExporterOptions } from '../../src/export/mongo';
import { mongoExporter } from '../../src/export/mongo';
import { instrumentMongo } from '../../src/instrument/commands';

declare const db: Db;
declare const client: MongoClient;
declare const telemetry: Telemetry;

// It is an `Exporter`, which is the point: it goes in the same list as
// `consoleExporter()`.
const exporter: Exporter = mongoExporter({ db });
void exporter;

void mongoExporter({ db, collection: 'signals', retention: 7 * 86_400_000 });
void mongoExporter({ db, retention: false });
void mongoExporter({ uri: 'mongodb://localhost', database: 'telemetry' });

// @ts-expect-error — one or the other: a `db` beside a `uri` ignores one
void mongoExporter({ db, uri: 'mongodb://localhost', database: 'x' });

// @ts-expect-error — a uri without a database has nowhere to write
void mongoExporter({ uri: 'mongodb://localhost' });

// @ts-expect-error — neither is not an exporter, it is a typo
void mongoExporter({});

// @ts-expect-error — retention is milliseconds or `false`, not '30d'
void mongoExporter({ db, retention: '30d' });

// @ts-expect-error — a misspelled option would otherwise be silently ignored
void mongoExporter({ db, collections: 'signals' });

// The options are read-only: an exporter does not change under the telemetry.
const options: MongoExporterOptions = { db };
// @ts-expect-error — the collection is fixed when the exporter is built
options.collection = 'elsewhere';

// Instrumenting answers the function that stops it.
const stop: () => void = instrumentMongo(client);
void stop;

void instrumentMongo(client, {
	telemetry,
	traced: (event) => event.commandName !== 'insert',
	spanName: (event) => `mongo.${event.commandName}`,
});

// @ts-expect-error — it instruments a client, not a database
void instrumentMongo(db);

// @ts-expect-error — `traced` answers yes or no, not a span name
void instrumentMongo(client, { traced: () => 'yes' });

// @ts-expect-error — the event is the driver's, and has no `collection` field
void instrumentMongo(client, { spanName: (event) => event.collection });
