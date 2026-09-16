import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import {
	createLogger,
	createTelemetry,
	type Exporter,
	neverSample,
	type Resource,
	type Signal,
	type SpanRecord,
	span,
	type Telemetry,
	withTelemetry,
} from '@nxgt/telemetry';
import { MongoClient } from 'mongodb';
import { startMongo, type TestServer } from '../../test/server';
import { DRIVER_COMMANDS, instrumentMongo, MAX_IN_FLIGHT } from './commands';

let server: TestServer;
let watched: MongoClient;
let collected: Signal[] = [];
let stop: (() => void) | undefined;

function collecting(): Exporter {
	return {
		export(_resource: Resource, batch: readonly Signal[]): void {
			collected.push(...batch);
		},
	};
}

function spans(): SpanRecord[] {
	return collected.filter((one): one is SpanRecord => one.type === 'span');
}

function instance(): Telemetry {
	return createTelemetry('checkout', { exporters: [collecting()], batch: 1 });
}

beforeAll(async () => {
	server = await startMongo();
	// The option that makes the driver emit anything at all, and the one
	// mistake worth checking for first.
	watched = await MongoClient.connect(server.uri, { monitorCommands: true });
}, 120_000);

beforeEach(() => {
	collected = [];
});

afterEach(async () => {
	stop?.();
	stop = undefined;
	await server.reset();
});

afterAll(async () => {
	await watched.close();
	await server.stop();
});

function orders() {
	return watched.db('nxgt-telemetry').collection('orders');
}

describe('a command the application sends', () => {
	test('is a client span named for the command and the collection', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry });

		await orders().insertOne({ id: 'o-1' });
		await telemetry.close();

		const inserted = spans().find((one) => one.name.startsWith('insert'));
		expect(inserted?.name).toBe('insert orders');
		expect(inserted?.kind).toBe('client');
	});

	test('carries the database, the collection, the operation and the server', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry });

		await orders().insertOne({ id: 'o-1' });
		await telemetry.close();

		const inserted = spans().find((one) => one.name.startsWith('insert'));
		expect(inserted?.attributes).toMatchObject({
			'db.system.name': 'mongodb',
			'db.namespace': 'nxgt-telemetry',
			'db.collection.name': 'orders',
			'db.operation.name': 'insert',
			'server.address': '127.0.0.1',
		});
		expect(typeof inserted?.attributes['server.port']).toBe('number');
	});

	test('measures the command, and ends after it starts', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry });

		await orders().insertOne({ id: 'o-1' });
		await telemetry.close();

		const inserted = spans().find((one) => one.name.startsWith('insert'));
		expect(inserted?.endedAt).toBeGreaterThanOrEqual(
			inserted?.startedAt as number,
		);
	});

	/**
	 * A command document holds the query, and a query holds the data. Only the
	 * collection name is read out of it.
	 */
	test('records nothing out of the command but the collection', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry });

		await orders().findOne({ secret: 'do-not-log-me' });
		await telemetry.close();

		expect(JSON.stringify(spans())).not.toContain('do-not-log-me');
	});

	test('a failing command is an error, with what the driver reported', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry });

		await watched
			.db('nxgt-telemetry')
			.command({ thisIsNotACommand: 1 })
			.catch(() => undefined);
		await telemetry.close();

		const failed = spans().find((one) => one.status === 'error');
		expect(failed).toBeDefined();
		expect(failed?.error?.type).toBeDefined();
	});
});

describe('where the span hangs', () => {
	/**
	 * A query made inside a request lands under that request. This is what
	 * command monitoring makes possible and what monkey-patching is usually
	 * used for.
	 */
	test('a command inside a span is a child of it', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry });

		await withTelemetry(telemetry, () =>
			span('GET /orders/:id', { kind: 'server' }, async () => {
				await orders().insertOne({ id: 'o-1' });
			}),
		);
		await telemetry.close();

		const request = spans().find((one) => one.kind === 'server');
		const inserted = spans().find((one) => one.name.startsWith('insert'));

		expect(inserted?.parent).toBe(request?.context.spanId);
		expect(inserted?.context.traceId).toBe(request?.context.traceId);
	});

	test('a command outside every span starts its own trace', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry });

		await orders().insertOne({ id: 'o-1' });
		await telemetry.close();

		const inserted = spans().find((one) => one.name.startsWith('insert'));
		expect(inserted?.parent).toBeUndefined();
		expect(inserted?.context.traceId).toBeDefined();
	});

	/**
	 * Sampling is decided once by the root and inherited, which is what keeps a
	 * trace whole rather than missing its middle.
	 */
	test('an unsampled request does not emit its commands either', async () => {
		const telemetry = createTelemetry('checkout', {
			exporters: [collecting()],
			batch: 1,
			sampler: neverSample,
		});
		stop = instrumentMongo(watched, { telemetry });

		await withTelemetry(telemetry, () =>
			span('GET /orders/:id', { kind: 'server' }, async () => {
				await orders().insertOne({ id: 'o-1' });
			}),
		);
		await telemetry.close();

		expect(spans()).toHaveLength(0);
	});

	/**
	 * A command with nothing above it *is* a root, so it asks the sampler
	 * exactly as `span()` would — this is the one place in the package that
	 * asks it at all.
	 */
	test('a command that is its own root asks the sampler', async () => {
		const telemetry = createTelemetry('checkout', {
			exporters: [collecting()],
			batch: 1,
			sampler: neverSample,
		});
		stop = instrumentMongo(watched, { telemetry });

		await orders().insertOne({ id: 'o-1' });
		await telemetry.close();

		expect(spans()).toHaveLength(0);
	});

	/**
	 * Instrumentation must not become the reason a query fails, and a span kept
	 * is the answer that loses nothing.
	 */
	test('a sampler that throws keeps the span', async () => {
		const telemetry = createTelemetry('checkout', {
			exporters: [collecting()],
			batch: 1,
			sampler: {
				sample(): boolean {
					throw new Error('the sampler is broken');
				},
			},
		});
		stop = instrumentMongo(watched, { telemetry });

		await orders().insertOne({ id: 'o-1' });
		await telemetry.close();

		expect(spans().some((one) => one.name.startsWith('insert'))).toBe(true);
	});

	test('two concurrent requests do not take each other commands', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry });

		await withTelemetry(telemetry, () =>
			Promise.all(
				['a', 'b'].map((id) =>
					span(`GET /orders/${id}`, { kind: 'server' }, async () => {
						await orders().insertOne({ id });
					}),
				),
			),
		);
		await telemetry.close();

		const requests = spans().filter((one) => one.kind === 'server');
		const inserts = spans().filter((one) => one.name.startsWith('insert'));
		const parents = new Set(inserts.map((one) => one.parent));

		expect(requests).toHaveLength(2);
		expect(inserts).toHaveLength(2);
		expect(parents.size).toBe(2);
		for (const request of requests) {
			expect(parents.has(request.context.spanId)).toBe(true);
		}
	});
});

describe('what it leaves alone', () => {
	/**
	 * The one place in this library where something is skipped by default. A
	 * heartbeat every ten seconds on every connection is not the application's
	 * work, and a trace full of `hello` is a trace nobody reads.
	 */
	test('the driver talking to itself is not the application working', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry });

		await watched.db('nxgt-telemetry').command({ ping: 1 });
		await orders().insertOne({ id: 'o-1' });
		await telemetry.close();

		expect(spans().map((one) => one.name)).toEqual(['insert orders']);
		expect(DRIVER_COMMANDS.has('ping')).toBe(true);
	});

	test('traced can ask for them back', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry, traced: () => true });

		await watched.db('nxgt-telemetry').command({ ping: 1 });
		await telemetry.close();

		expect(spans().some((one) => one.name.startsWith('ping'))).toBe(true);
	});

	test('traced can refuse a collection', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, {
			telemetry,
			traced: (event) => event.command?.insert !== 'sessions',
		});

		await watched
			.db('nxgt-telemetry')
			.collection('sessions')
			.insertOne({ a: 1 });
		await orders().insertOne({ id: 'o-1' });
		await telemetry.close();

		expect(spans().map((one) => one.name)).toEqual(['insert orders']);
	});

	test('spanName can replace the name', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, {
			telemetry,
			spanName: (event) => `mongo.${event.commandName}`,
		});

		await orders().insertOne({ id: 'o-1' });
		await telemetry.close();

		expect(spans().map((one) => one.name)).toEqual(['mongo.insert']);
	});
});

describe('turning it off', () => {
	test('the returned function stops it, and the client still works', async () => {
		const telemetry = instance();
		const off = instrumentMongo(watched, { telemetry });

		await orders().insertOne({ id: 'o-1' });
		off();
		await orders().insertOne({ id: 'o-2' });
		await telemetry.close();

		expect(spans().filter((one) => one.name.startsWith('insert'))).toHaveLength(
			1,
		);
		expect(await orders().countDocuments()).toBe(2);
	});

	test('with no telemetry anywhere it is inert, and the query still runs', async () => {
		stop = instrumentMongo(watched);

		await orders().insertOne({ id: 'o-1' });

		expect(collected).toHaveLength(0);
		expect(await orders().countDocuments()).toBe(1);
	});

	/**
	 * `monitorCommands: true` is a connection option, read when the client is
	 * built, and cannot be turned on from here. Without it the driver emits
	 * nothing and this is silently inert.
	 */
	test('a client built without monitorCommands emits nothing', async () => {
		const quiet = await MongoClient.connect(server.uri);
		const telemetry = instance();
		const off = instrumentMongo(quiet, { telemetry });

		await quiet
			.db('nxgt-telemetry')
			.collection('orders')
			.insertOne({ id: 'o' });
		off();
		await quiet.close();
		await telemetry.close();

		expect(spans()).toHaveLength(0);
	});
});

describe('alongside the logger', () => {
	test('a log written in the request carries the same trace as its query', async () => {
		const telemetry = instance();
		const log = createLogger('CheckoutService');
		stop = instrumentMongo(watched, { telemetry });

		await withTelemetry(telemetry, () =>
			span('GET /orders/:id', { kind: 'server' }, async () => {
				await orders().insertOne({ id: 'o-1' });
				log.info('order stored');
			}),
		);
		await telemetry.close();

		const written = collected.find((one) => one.type === 'log');
		const inserted = spans().find((one) => one.name.startsWith('insert'));

		expect(written?.type === 'log' && written.span?.traceId).toBe(
			inserted?.context.traceId,
		);
	});
});

/**
 * Two things the driver does but not on demand: it aborts a command, and it
 * drops a connection between the start of a command and its reply. Both are
 * emitted here rather than provoked — the events are the driver's own public
 * shape, and waiting for a real dropped socket would make the suite a race.
 */
describe('what the driver reports but a test cannot provoke', () => {
	function begin(requestId: number): void {
		watched.emit('commandStarted', {
			requestId,
			databaseName: 'nxgt-telemetry',
			commandName: 'find',
			command: { find: 'orders' },
			address: '127.0.0.1:27017',
			connectionId: 1,
		} as never);
	}

	/**
	 * A dashboard that counts an abort as a failure is a dashboard nobody
	 * trusts. It is the same rule `@nxgt/telemetry-httpyz` applies to a
	 * timeout.
	 */
	test('an aborted command is cancelled, not an error', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry });

		begin(90_001);
		const aborted = new Error('The operation was aborted');
		aborted.name = 'AbortError';
		watched.emit('commandFailed', {
			requestId: 90_001,
			failure: aborted,
			duration: 3,
		} as never);
		await telemetry.close();

		const found = spans().find((one) => one.name === 'find orders');
		expect(found?.status).toBe('cancelled');
	});

	/**
	 * A command that never ends — a connection dropped between the two events —
	 * would otherwise be remembered for ever. Forgetting it costs one span; not
	 * forgetting it costs the process.
	 */
	test('the oldest in-flight command is forgotten once the map is full', async () => {
		const telemetry = instance();
		stop = instrumentMongo(watched, { telemetry });

		begin(1);
		// One past the ceiling: the map fills, and the next arrival evicts.
		for (let id = 2; id <= MAX_IN_FLIGHT + 1; id += 1) begin(id);

		// The first one is gone, so its reply finds nothing to end.
		watched.emit('commandSucceeded', {
			requestId: 1,
			duration: 2,
		} as never);
		// The one after it is still there.
		watched.emit('commandSucceeded', {
			requestId: 2,
			duration: 2,
		} as never);
		await telemetry.close();

		expect(spans()).toHaveLength(1);
	});
});
