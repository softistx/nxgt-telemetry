import { join } from 'node:path';
import { type Db, MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server-core';

/**
 * The mongod the specs run against. **Pinned**, because the memory server's own
 * default moves between its minor releases, and because the build it picks
 * decides which OpenSSL it needs: 6.0 and up resolve to the ubuntu 22.04 build,
 * which links OpenSSL 3 — the one a current distribution ships. Older ones want
 * `libcrypto.so.1.1` and do not start.
 *
 * CI keys its binary cache on the hash of this file, so changing the version
 * here is what makes it download a new one.
 */
export const MONGOD_VERSION = '8.2.6';

/** Where the binary is cached: the repository's git-ignored `.cache`. */
export const MONGOD_CACHE = join(
	new URL('../../..', import.meta.url).pathname,
	'.cache',
	'mongodb',
);

export interface TestServer {
	uri: string;
	client: MongoClient;
	db: Db;
	/** Drops the database, so each test starts from an empty one. */
	reset(): Promise<void>;
	stop(): Promise<void>;
}

/**
 * A real MongoDB, one per spec file.
 *
 * **Standalone, not a replica set**: unlike `@nxgt/mongo` in `nxgt-data`,
 * nothing here uses a transaction — telemetry is written with an unordered
 * `insertMany` and read back — so the extra second a replica set takes to elect
 * itself buys nothing.
 *
 * It has to be a real mongod. Retention is a **TTL index**, and the behaviour
 * that matters is how Mongo refuses to redefine one under the same name with
 * different options. Nothing fake answers that.
 */
export async function startMongo(
	dbName = 'nxgt-telemetry',
): Promise<TestServer> {
	const server = await MongoMemoryServer.create({
		binary: { version: MONGOD_VERSION, downloadDir: MONGOD_CACHE },
		// 10 seconds is the default, and a cold CI runner takes longer.
		instance: { launchTimeout: 60_000 },
	});

	const uri = server.getUri(dbName);
	const client = await MongoClient.connect(uri);
	const db = client.db(dbName);

	return {
		uri,
		client,
		db,
		reset: async () => {
			await db.dropDatabase();
		},
		stop: async () => {
			await client.close();
			await server.stop({ doCleanup: true });
		},
	};
}
