import type { Exporter, Resource, Signal } from '@nxgt/telemetry';
import type { Db, MongoClient } from 'mongodb';
import { documentOf } from './documents';

/** 30 days. Long enough to explain last month's incident, short enough to keep. */
export const DEFAULT_RETENTION = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_COLLECTION = 'telemetry';
/** The TTL index's name. Fixed, so it can be recognised and replaced. */
export const RETENTION_INDEX = 'nxgt_telemetry_retention';

interface Shared {
	/** Default `telemetry`. */
	readonly collection?: string;
	/**
	 * How long a signal is kept, in milliseconds. Default 30 days. `false`
	 * keeps everything, and creates no index.
	 */
	readonly retention?: number | false;
}

/**
 * Either write into a database you already have, or give a URI and let this
 * open its own pool. The compiler refuses both: a `db` beside a `uri` would
 * silently ignore one of them.
 */
export type MongoExporterOptions =
	| (Shared & { readonly db: Db; readonly uri?: undefined })
	| (Shared & {
			readonly uri: string;
			readonly database: string;
			readonly db?: undefined;
	  });

/**
 * Signals into a MongoDB collection, one document each.
 *
 * ```ts
 * mongoExporter({ db, retention: 7 * 24 * 60 * 60 * 1000 })
 * ```
 *
 * For an estate that already runs Mongo and does not want a collector: the
 * documents are the signals, so `db.telemetry.find({ traceId })` is the whole
 * query language, and a TTL index is the whole retention policy.
 *
 * **A `db` you pass is never closed** — it is yours, and this is one of several
 * things using it. The `uri` form opens its **own pool**, so a burst of
 * telemetry cannot starve the connections your application's queries need, and
 * closes it on `close()`.
 */
export function mongoExporter(options: MongoExporterOptions): Exporter {
	const name = options.collection ?? DEFAULT_COLLECTION;
	const retention = options.retention ?? DEFAULT_RETENTION;

	let owned: MongoClient | undefined;
	let opening: Promise<Db> | undefined;
	/** The retention the index on disk was last made for. */
	let indexed: number | false | undefined;

	const database = async (): Promise<Db> => {
		if (options.db !== undefined) return options.db;
		opening ??= open(options.uri, options.database).then((opened) => {
			owned = opened.client;
			return opened.db;
		});
		return opening;
	};

	return {
		async export(resource: Resource, batch: readonly Signal[]): Promise<void> {
			if (batch.length === 0) return;

			const db = await database();
			const collection = db.collection(name);

			if (indexed !== retention) {
				await ensureRetention(db, name, retention);
				indexed = retention;
			}

			// **Unordered.** One document Mongo refuses — a key it will not
			// take, a size limit — must not cost the other 511 behind it.
			await collection.insertMany(
				batch.map((signal) => documentOf(resource, signal)),
				{ ordered: false },
			);
		},

		async close(): Promise<void> {
			// Only a pool this exporter opened. A `db` that was passed in
			// belongs to the application.
			await owned?.close();
		},
	};
}

/**
 * The TTL index, created lazily and **recreated when the retention changes**.
 *
 * Mongo will not redefine an index under the same name with different options:
 * it answers `IndexOptionsConflict` rather than quietly adopting the new value.
 * So a retention that changed means dropping the index and making it again —
 * which is why the name is fixed, and why nothing else should use it.
 */
export async function ensureRetention(
	db: Db,
	name: string,
	retention: number | false,
): Promise<void> {
	const collection = db.collection(name);
	const found = await existing(collection, RETENTION_INDEX);

	if (retention === false) {
		// Keeping everything means there must be no index, including one an
		// earlier configuration left behind.
		if (found !== undefined) await collection.dropIndex(RETENTION_INDEX);
		return;
	}

	const seconds = Math.max(Math.round(retention / 1_000), 0);
	if (found?.expireAfterSeconds === seconds) return;
	if (found !== undefined) await collection.dropIndex(RETENTION_INDEX);

	await collection.createIndex(
		{ at: 1 },
		{ name: RETENTION_INDEX, expireAfterSeconds: seconds },
	);
}

async function existing(
	collection: ReturnType<Db['collection']>,
	name: string,
): Promise<{ expireAfterSeconds?: number } | undefined> {
	try {
		const indexes = (await collection.indexes()) as {
			name?: string;
			expireAfterSeconds?: number;
		}[];
		return indexes.find((index) => index.name === name);
	} catch {
		// The collection does not exist yet, which is not a problem: creating
		// the index creates it.
		return undefined;
	}
}

async function open(
	uri: string,
	database: string,
): Promise<{ client: MongoClient; db: Db }> {
	// Imported here rather than at the top, so the package loads in an
	// application that has the exporter's sibling but not the driver.
	const { MongoClient: Client } = await import('mongodb');
	const client = await Client.connect(uri);
	return { client, db: client.db(database) };
}
