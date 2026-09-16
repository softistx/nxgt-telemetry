import { describe, expect, test } from 'bun:test';
import type { CommandStartedEvent } from 'mongodb';
import {
	collectionOf,
	commandAttributes,
	commandName,
	splitAddress,
} from './db';

function started(over: Partial<CommandStartedEvent> = {}): CommandStartedEvent {
	return {
		requestId: 1,
		databaseName: 'shop',
		commandName: 'find',
		command: { find: 'orders', filter: { total: { $gt: 10 } } },
		address: '127.0.0.1:27017',
		connectionId: 1,
		...over,
	} as CommandStartedEvent;
}

describe('collectionOf', () => {
	/** The wire protocol's own rule: `{ find: 'orders', … }`. */
	test('is the command document value named by the command', () => {
		expect(collectionOf(started())).toBe('orders');
	});

	test('is nothing when that value is not a string', () => {
		expect(
			collectionOf(started({ commandName: 'ping', command: { ping: 1 } })),
		).toBeUndefined();
	});

	test('is nothing when there is no command document at all', () => {
		expect(
			collectionOf(started({ command: undefined as never })),
		).toBeUndefined();
	});

	/** A getter that throws must not become the reason a query fails. */
	test('is nothing when reading the command throws', () => {
		const hostile = started({
			command: new Proxy(
				{},
				{
					get(): never {
						throw new Error('no');
					},
				},
			) as never,
		});

		expect(collectionOf(hostile)).toBeUndefined();
	});
});

describe('commandName', () => {
	test('is the command and its collection', () => {
		expect(commandName(started())).toBe('find orders');
	});

	test('falls back to the database when no collection is named', () => {
		expect(
			commandName(started({ commandName: 'ping', command: { ping: 1 } })),
		).toBe('ping shop');
	});
});

describe('commandAttributes', () => {
	test('names the system, the database, the operation and the collection', () => {
		expect(commandAttributes(started())).toEqual({
			'db.system.name': 'mongodb',
			'db.namespace': 'shop',
			'db.operation.name': 'find',
			'db.collection.name': 'orders',
			'server.address': '127.0.0.1',
			'server.port': 27017,
		});
	});

	/** Nothing from the command document but the collection name. */
	test('carries nothing from the query', () => {
		const flat = JSON.stringify(commandAttributes(started()));

		expect(flat).not.toContain('filter');
		expect(flat).not.toContain('$gt');
	});

	test('omits a collection the command does not name', () => {
		const attributes = commandAttributes(
			started({ commandName: 'ping', command: { ping: 1 } }),
		);

		expect(attributes).not.toHaveProperty('db.collection.name');
	});
});

describe('splitAddress', () => {
	test('splits host and port', () => {
		expect(splitAddress('mongo.internal:27017')).toEqual([
			'mongo.internal',
			27017,
		]);
	});

	/**
	 * The brackets are kept, because `new URL(…).hostname` keeps them too — a
	 * client span from here and one from `@nxgt/telemetry-httpyz` must agree
	 * about `server.address`.
	 */
	test('keeps the brackets of an IPv6 literal', () => {
		expect(splitAddress('[::1]:27017')).toEqual(['[::1]', 27017]);
	});

	/** `Number('')` is 0, and a port of 0 on every span is a wrong answer. */
	test('a trailing colon is part of the address, not an empty port', () => {
		expect(splitAddress('mongo.internal:')).toEqual([
			'mongo.internal:',
			undefined,
		]);
	});

	/** `::1` would otherwise split to the host `::` and the port `1`. */
	test('a bracket-less IPv6 literal is the whole address', () => {
		expect(splitAddress('::1')).toEqual(['::1', undefined]);
	});

	test('a unix socket path is the whole address', () => {
		expect(splitAddress('/tmp/mongodb-27017.sock')).toEqual([
			'/tmp/mongodb-27017.sock',
			undefined,
		]);
	});

	test('a non-numeric port is part of the address', () => {
		expect(splitAddress('mongo.internal:mongo')).toEqual([
			'mongo.internal:mongo',
			undefined,
		]);
	});

	test('an address nothing was reported for is neither', () => {
		expect(splitAddress('')).toEqual([undefined, undefined]);
		expect(splitAddress(undefined as never)).toEqual([undefined, undefined]);
	});
});
