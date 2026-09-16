/**
 * Type tests. They are checked by `bun run typecheck` and never run: a call
 * that must not compile carries `@ts-expect-error`, and if it starts compiling
 * tsc fails on the unused directive.
 */

import type { Exporter, Resource, Signal, Telemetry } from '@nxgt/telemetry';
import type { CommandStartedEvent, Db, MongoClient } from 'mongodb';
import {
	collectionOf,
	commandAttributes,
	commandName,
	splitAddress,
} from '../../src/attributes/db';
import type { SignalDocument } from '../../src/export/documents';
import { documentOf } from '../../src/export/documents';
import type { MongoExporterOptions } from '../../src/export/mongo';
import { ensureRetention, mongoExporter } from '../../src/export/mongo';
import { instrumentMongo } from '../../src/instrument/commands';

declare const db: Db;
declare const client: MongoClient;
declare const telemetry: Telemetry;
declare const resource: Resource;
declare const signal: Signal;
declare const commandStarted: CommandStartedEvent;

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

// --- the stored document -------------------------------------------------

const document: SignalDocument = documentOf(resource, signal);
// `at` is a BSON `Date`, which is what makes a range query and a TTL index
// possible; a number here would compile and be wrong.
const at: Date = document.at;
void at;

// @ts-expect-error — the resource comes first: swapped, neither fits
void documentOf(signal, resource);

// @ts-expect-error — a document is built from a signal, not from a span name
void documentOf(resource, 'charge');

// @ts-expect-error — the document is read-only, like the signal it is built from
document.service = 'elsewhere';

// --- the retention index -------------------------------------------------

void ensureRetention(db, 'telemetry', 30 * 86_400_000);
void ensureRetention(db, 'telemetry', false);

// @ts-expect-error — milliseconds or `false`, the same as the option
void ensureRetention(db, 'telemetry', '30d');

// @ts-expect-error — the collection is named, not handed over
void ensureRetention(db, db.collection('telemetry'), 1_000);

// --- what a command is about ---------------------------------------------

const collection: string | undefined = collectionOf(commandStarted);
void collection;

// @ts-expect-error — it reads the driver's event, not a bare command document
void collectionOf({ find: 'orders' });

// @ts-expect-error — the same event the driver emits, not just its name
void collectionOf('find');

const [host, port] = splitAddress('127.0.0.1:27017');
void host;
void port;

// @ts-expect-error — an address is one string; the port is not passed beside it
void splitAddress('127.0.0.1', 27017);

// @ts-expect-error — `commandName` builds a span name from the event
void commandName('find');

// @ts-expect-error — attributes come from the event, not from a collection name
void commandAttributes('orders');
