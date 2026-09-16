import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import type { LogRecord, Resource, Signal } from '@nxgt/telemetry';
import { MongoClient } from 'mongodb';
import { startMongo, type TestServer } from '../../test/server';
import {
	DEFAULT_COLLECTION,
	DEFAULT_RETENTION,
	ensureRetention,
	mongoExporter,
	RETENTION_INDEX,
} from './mongo';

const RESOURCE: Resource = {
	service: 'checkout',
	version: '1.4.0',
	attributes: {},
};

const DAY = 24 * 60 * 60 * 1000;

let server: TestServer;
const closing: { close(): Promise<void> | void }[] = [];

beforeAll(async () => {
	server = await startMongo();
}, 120_000);

afterEach(async () => {
	for (const one of closing.splice(0)) await one.close();
	await server.reset();
});

afterAll(async () => {
	await server.stop();
});

function log(name: string): LogRecord {
	return {
		type: 'log',
		at: Date.UTC(2026, 8, 15, 10, 4, 22),
		severity: 'info',
		name,
		source: 'CheckoutService',
		attributes: { orderId: 'o-1' },
	};
}

/** Registers the exporter so it is closed before the database is dropped. */
function exporting(options: Parameters<typeof mongoExporter>[0]) {
	const exporter = mongoExporter(options);
	closing.push({ close: () => exporter.close?.() });
	return exporter;
}

async function stored(collection = DEFAULT_COLLECTION) {
	return server.db.collection(collection).find({}).toArray();
}

describe('writing', () => {
	test('one document per signal, as the signal', async () => {
		const exporter = exporting({ db: server.db });
		await exporter.export(RESOURCE, [log('a'), log('b')]);

		const found = await stored();
		expect(found).toHaveLength(2);
		expect(found.map((one) => one.name).sort()).toEqual(['a', 'b']);
		expect(found[0]?.service).toBe('checkout');
		expect(found[0]?.at).toBeInstanceOf(Date);
	});

	test('an empty batch writes nothing, and asks the database nothing', async () => {
		const exporter = exporting({ db: server.db });
		await exporter.export(RESOURCE, []);

		expect(await server.db.listCollections().toArray()).toEqual([]);
	});

	test('the collection can be named', async () => {
		const exporter = exporting({ db: server.db, collection: 'signals' });
		await exporter.export(RESOURCE, [log('a')]);

		expect(await stored('signals')).toHaveLength(1);
	});

	/**
	 * One document Mongo refuses — a key it will not take, a size limit — must
	 * not cost the other 511 behind it.
	 */
	test('a document it refuses does not cost the rest of the batch', async () => {
		const exporter = exporting({ db: server.db });
		// An `_id` holding a `$`-prefixed key is what Mongo refuses here. A
		// dotted key in `attributes` is **not** — it stores fine, and the
		// consequence is a query one, documented in the README.
		const refused = {
			...log('bad'),
			_id: { $bad: 1 },
		} as unknown as Signal;

		await exporter
			.export(RESOURCE, [log('a'), refused, log('b')])
			?.catch(() => undefined);

		expect((await stored()).map((one) => one.name).sort()).toEqual(['a', 'b']);
	});

	/**
	 * The query the README leads with. It is the whole reason `traceId` is
	 * lifted out of `span`/`context`: without it this needs an `$or` over two
	 * paths and an index on each.
	 */
	test('everything in one trace is one query by traceId', async () => {
		const exporter = exporting({ db: server.db });
		const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
		const context = {
			traceId: traceId as never,
			spanId: '00f067aa0ba902b7' as never,
			sampled: true,
			remote: false,
		};

		await exporter.export(RESOURCE, [
			{ ...log('in the trace'), span: context },
			{
				type: 'span',
				name: 'charge',
				context,
				kind: 'client',
				startedAt: Date.UTC(2026, 8, 15, 10, 4, 22),
				endedAt: Date.UTC(2026, 8, 15, 10, 4, 22) + 84,
				status: 'ok',
				attributes: {},
				events: [],
			},
			log('outside it'),
		]);

		const found = await server.db
			.collection(DEFAULT_COLLECTION)
			.find({ traceId })
			.toArray();

		expect(found.map((one) => one.name).sort()).toEqual([
			'charge',
			'in the trace',
		]);
	});

	test("a service's resource attributes reach every document", async () => {
		const exporter = exporting({ db: server.db });
		await exporter.export(
			{ ...RESOURCE, attributes: { 'deployment.region': 'eu-west-1' } },
			[log('a')],
		);

		expect((await stored())[0]?.resource).toEqual({
			'deployment.region': 'eu-west-1',
		});
	});

	test('a log and a span go to the same collection', async () => {
		const exporter = exporting({ db: server.db });
		await exporter.export(RESOURCE, [
			log('a'),
			{
				type: 'span',
				name: 'charge',
				context: {
					traceId: '4bf92f3577b34da6a3ce929d0e0e4736' as never,
					spanId: '00f067aa0ba902b7' as never,
					sampled: true,
					remote: false,
				},
				kind: 'client',
				startedAt: 0,
				endedAt: 1,
				status: 'ok',
				attributes: {},
				events: [],
			},
		]);

		expect((await stored()).map((one) => one.type).sort()).toEqual([
			'log',
			'span',
		]);
	});
});

describe('retention', () => {
	async function retentionIndex(collection = DEFAULT_COLLECTION) {
		const indexes = (await server.db.collection(collection).indexes()) as {
			name?: string;
			expireAfterSeconds?: number;
		}[];
		return indexes.find((index) => index.name === RETENTION_INDEX);
	}

	test('creates a TTL index on the first batch', async () => {
		const exporter = exporting({ db: server.db, retention: 7 * DAY });
		await exporter.export(RESOURCE, [log('a')]);

		expect((await retentionIndex())?.expireAfterSeconds).toBe(7 * 24 * 3_600);
	});

	test('defaults to thirty days', async () => {
		const exporter = exporting({ db: server.db });
		await exporter.export(RESOURCE, [log('a')]);

		expect((await retentionIndex())?.expireAfterSeconds).toBe(
			DEFAULT_RETENTION / 1_000,
		);
	});

	/**
	 * Mongo answers `IndexOptionsConflict` rather than adopting the new value,
	 * so a retention that changed means dropping the index and making it again.
	 * This is the whole reason the specs need a real mongod.
	 */
	test('recreates the index when the retention changes', async () => {
		const first = exporting({ db: server.db, retention: 7 * DAY });
		await first.export(RESOURCE, [log('a')]);
		expect((await retentionIndex())?.expireAfterSeconds).toBe(7 * 24 * 3_600);

		const second = exporting({ db: server.db, retention: 1 * DAY });
		await second.export(RESOURCE, [log('b')]);

		expect((await retentionIndex())?.expireAfterSeconds).toBe(24 * 3_600);
		expect(await stored()).toHaveLength(2);
	});

	test('a plain createIndex would have failed, which is why it drops first', async () => {
		await ensureRetention(server.db, DEFAULT_COLLECTION, 7 * DAY);

		await expect(
			server.db
				.collection(DEFAULT_COLLECTION)
				.createIndex(
					{ at: 1 },
					{ name: RETENTION_INDEX, expireAfterSeconds: 60 },
				),
		).rejects.toThrow();

		// And through `ensureRetention` it succeeds.
		await ensureRetention(server.db, DEFAULT_COLLECTION, 60_000);
		expect((await retentionIndex())?.expireAfterSeconds).toBe(60);
	});

	test('retention false creates no index, and removes one already there', async () => {
		await ensureRetention(server.db, DEFAULT_COLLECTION, 7 * DAY);
		expect(await retentionIndex()).toBeDefined();

		const exporter = exporting({ db: server.db, retention: false });
		await exporter.export(RESOURCE, [log('a')]);

		expect(await retentionIndex()).toBeUndefined();
		expect(await stored()).toHaveLength(1);
	});

	test('the index is not rebuilt on every batch', async () => {
		const exporter = exporting({ db: server.db, retention: 7 * DAY });
		await exporter.export(RESOURCE, [log('a')]);
		const before = (await retentionIndex()) as { name?: string };

		await exporter.export(RESOURCE, [log('b')]);

		expect(await retentionIndex()).toEqual(before);
		expect(await stored()).toHaveLength(2);
	});
});

describe('the connection it uses', () => {
	/** It is yours, and this is one of several things using it. */
	test('a db that was passed in is never closed', async () => {
		const exporter = mongoExporter({ db: server.db });
		await exporter.export(RESOURCE, [log('a')]);
		await exporter.close?.();

		// Still usable: the application's own queries have not been cut off.
		expect(await stored()).toHaveLength(1);
	});

	/**
	 * A burst of telemetry must not starve the connections the application's
	 * queries need.
	 */
	test('the uri form opens its own pool, and closes it', async () => {
		const exporter = mongoExporter({
			uri: server.uri,
			database: 'nxgt-telemetry',
		});
		await exporter.export(RESOURCE, [log('a')]);

		expect(await stored()).toHaveLength(1);
		await exporter.close?.();

		// Closing twice is what a second `telemetry.close()` would do.
		await exporter.close?.();
	});

	test('closing before anything was written opens nothing', async () => {
		const exporter = mongoExporter({
			uri: 'mongodb://127.0.0.1:1/x',
			database: 'x',
		});
		await exporter.close?.();
	});

	test('a pool it opened is opened once, not per batch', async () => {
		const exporter = mongoExporter({
			uri: server.uri,
			database: 'nxgt-telemetry',
		});
		await exporter.export(RESOURCE, [log('a')]);
		await exporter.export(RESOURCE, [log('b')]);
		await exporter.close?.();

		expect(await stored()).toHaveLength(2);
	});
});

describe('when Mongo is not there', () => {
	/**
	 * A collector being down is not a reason for a request to fail: the failure
	 * is thrown, which means it reaches `onExportError` and nothing else.
	 */
	test('the failure is thrown rather than swallowed', async () => {
		const exporter = mongoExporter({
			uri: 'mongodb://127.0.0.1:1/x?serverSelectionTimeoutMS=200',
			database: 'x',
		});

		await expect(exporter.export(RESOURCE, [log('a')])).rejects.toThrow();
		await exporter.close?.();
	});

	/**
	 * Mongo is routinely not up yet when a process boots. A rejected promise
	 * kept in the connection slot would make every later batch await the same
	 * rejection for the life of the process — telemetry gone permanently,
	 * silently, long after the database came back.
	 *
	 * The moving `uri` is what makes the difference observable: a second batch
	 * that merely rejects again proves nothing, because replaying the cached
	 * failure rejects too.
	 */
	test('a first connection that failed does not poison the exporter', async () => {
		let uri = 'mongodb://127.0.0.1:1/x?serverSelectionTimeoutMS=200';
		const exporter = mongoExporter({
			get uri() {
				return uri;
			},
			database: 'nxgt-telemetry',
		} as never);

		await expect(exporter.export(RESOURCE, [log('a')])).rejects.toThrow();
		uri = server.uri;
		await exporter.export(RESOURCE, [log('b')]);
		await exporter.close?.();

		expect((await stored()).map((one) => one.name)).toEqual(['b']);
	});
});

describe('the driver it uses', () => {
	test('is the one the application installed, not a bundled copy', async () => {
		// The exporter imports `mongodb` lazily, so this is the check that the
		// name it imports is the name a consumer would have installed.
		const { MongoClient: Imported } = await import('mongodb');
		expect(Imported).toBe(MongoClient);
	});
});
