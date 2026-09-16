import { type Attributes, attributesOf } from '@nxgt/telemetry';
import type { CommandStartedEvent } from 'mongodb';

export const DB_SYSTEM = 'db.system.name';
export const DB_NAMESPACE = 'db.namespace';
export const DB_COLLECTION = 'db.collection.name';
export const DB_OPERATION = 'db.operation.name';
export const SERVER_ADDRESS = 'server.address';
export const SERVER_PORT = 'server.port';

export const MONGODB = 'mongodb';

/**
 * What is known about a command the moment it is sent.
 *
 * Through `attributesOf`, which is total: an address a driver reports as
 * something unexpected is rendered rather than thrown over.
 */
export function commandAttributes(event: CommandStartedEvent): Attributes {
	const collection = collectionOf(event);
	const [host, port] = splitAddress(event.address);

	return attributesOf({
		[DB_SYSTEM]: MONGODB,
		[DB_NAMESPACE]: event.databaseName,
		[DB_OPERATION]: event.commandName,
		...(collection === undefined ? {} : { [DB_COLLECTION]: collection }),
		...(host === undefined ? {} : { [SERVER_ADDRESS]: host }),
		...(port === undefined ? {} : { [SERVER_PORT]: port }),
	});
}

/**
 * The collection a command is about.
 *
 * It is the command document's **first** value, by the wire protocol's own
 * rule: `{ find: 'orders', filter: … }`. The value is not always a collection —
 * `{ ping: 1 }` — so it is only taken when it is a string.
 *
 * Nothing else in the command is read. A command document holds the query, and
 * a query holds the data.
 */
export function collectionOf(event: CommandStartedEvent): string | undefined {
	try {
		const value = event.command?.[event.commandName];
		return typeof value === 'string' ? value : undefined;
	} catch {
		return undefined;
	}
}

/** `"<command> <collection>"`, or the database when there is no collection. */
export function commandName(event: CommandStartedEvent): string {
	const collection = collectionOf(event);
	return `${event.commandName} ${collection ?? event.databaseName}`;
}

/**
 * An address into a host and a port.
 *
 * The driver reports `host:port`, and `[::1]:27017` for an IPv6 literal — the
 * brackets are kept, which is what `new URL(…).hostname` gives on the HTTP side
 * too, so a client span from here and one from `@nxgt/telemetry-httpyz` agree
 * about `server.address`. Anything else — a unix socket path, a bare `::1` — is
 * the whole address and no port, which is a looser answer than the two shapes
 * above but never a wrong host.
 */
export function splitAddress(
	address: string,
): [string | undefined, number | undefined] {
	if (typeof address !== 'string' || address === '') {
		return [undefined, undefined];
	}

	const colon = address.lastIndexOf(':');
	if (colon <= 0) return [address, undefined];

	const after = address.slice(colon + 1);
	// `Number('')` is 0, and a bracket-less `::1` would take `1` as its port.
	if (after === '' || !/^\d+$/.test(after)) return [address, undefined];

	const host = address.slice(0, colon);
	// `::1` splits to `::`, which is not a host. Only a bracketed literal is.
	if (host.includes(':') && !host.startsWith('[')) {
		return [address, undefined];
	}

	return [host, Number(after)];
}
