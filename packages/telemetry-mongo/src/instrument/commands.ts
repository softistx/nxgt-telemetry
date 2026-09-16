import {
	type Attributes,
	attributesOf,
	currentSpan,
	errorInfo,
	isAbort,
	randomSpanId,
	randomTraceId,
	resolveTelemetry,
	type SpanContext,
	type SpanRecord,
	type Telemetry,
	type TraceId,
} from '@nxgt/telemetry';
import type {
	CommandFailedEvent,
	CommandStartedEvent,
	CommandSucceededEvent,
	MongoClient,
} from 'mongodb';

export const DB_SYSTEM = 'db.system.name';
export const DB_NAMESPACE = 'db.namespace';
export const DB_COLLECTION = 'db.collection.name';
export const DB_OPERATION = 'db.operation.name';
export const SERVER_ADDRESS = 'server.address';
export const SERVER_PORT = 'server.port';

export const MONGODB = 'mongodb';

/**
 * The commands the driver sends on its own behalf: the handshake, the heartbeat,
 * authentication, session cleanup.
 *
 * These are skipped by default, and it is the one place in this library where
 * something is. Everywhere else nothing is skipped, because a library that
 * decides which of *your* work does not matter hides the one that did — but a
 * heartbeat every ten seconds on every connection is not your work at all, and
 * a trace full of `hello` is a trace nobody reads.
 */
export const DRIVER_COMMANDS: ReadonlySet<string> = new Set([
	'hello',
	'ismaster',
	'isMaster',
	'ping',
	'endSessions',
	'killSessions',
	'saslStart',
	'saslContinue',
	'authenticate',
	'getnonce',
	'buildInfo',
	'buildinfo',
]);

/**
 * How many commands may be in flight before the oldest is forgotten.
 *
 * A command that neither succeeds nor fails — a connection dropped between the
 * two events — would otherwise be remembered for ever. Forgetting it costs one
 * span; not forgetting it costs the process.
 */
export const MAX_IN_FLIGHT = 4_096;

export interface InstrumentOptions {
	/**
	 * Whether a command gets a span. Default: everything except
	 * {@link DRIVER_COMMANDS}.
	 */
	readonly traced?: (event: CommandStartedEvent) => boolean;
	/** The span's name. Default `"<command> <collection>"`, or the database. */
	readonly spanName?: (event: CommandStartedEvent) => string;
	/**
	 * The telemetry to write to. Default: the one in scope when the command
	 * started, and the installed one otherwise.
	 */
	readonly telemetry?: Telemetry;
}

interface InFlight {
	readonly telemetry: Telemetry;
	readonly parent: SpanContext | undefined;
	readonly context: SpanContext;
	readonly name: string;
	readonly attributes: Attributes;
	readonly startedAt: number;
}

/**
 * Client spans for every command the driver sends.
 *
 * ```ts
 * const client = new MongoClient(uri, { monitorCommands: true });
 * const stop = instrumentMongo(client);
 * ```
 *
 * **`monitorCommands: true` is required** and cannot be turned on from here: it
 * is a connection option, read when the client is built. Without it the driver
 * emits nothing and this is silently inert — which is the one mistake worth
 * checking for first.
 *
 * It listens to the driver's **public** command monitoring rather than patching
 * anything. No monkey-patching means it keeps working under Bun, where
 * `require-in-the-middle` — what the OpenTelemetry auto-instrumentations use —
 * does not.
 *
 * The span is **recorded, not opened**: monitoring gives a start event and an
 * end event, not a block to run inside. The parent is whatever span was open
 * when the command started, so a query made inside a request lands under that
 * request; a command the driver sends on its own has no parent and starts its
 * own trace.
 *
 * Returns the function that removes the listeners.
 */
export function instrumentMongo(
	client: MongoClient,
	options: InstrumentOptions = {},
): () => void {
	const traced = options.traced ?? notADriverCommand;
	const named = options.spanName ?? defaultName;
	const inFlight = new Map<number, InFlight>();

	const started = (event: CommandStartedEvent): void => {
		try {
			if (!traced(event)) return;

			// Read while the command's own async context is still current: by
			// the time the reply arrives, the caller's span may have closed and
			// the storage moved on.
			const telemetry = options.telemetry ?? resolveTelemetry();
			if (telemetry === undefined) return;

			const parent = currentSpan();
			const context = contextFor(telemetry, parent);
			// An unsampled trace is unsampled all the way down. Deciding here
			// rather than at the end also means the command is never
			// remembered, so an unsampled service pays nothing for this.
			if (!context.sampled) return;

			forget(inFlight);
			inFlight.set(event.requestId, {
				telemetry,
				parent,
				context,
				name: named(event),
				attributes: attributesFor(event),
				startedAt: Date.now(),
			});
		} catch {
			// Instrumentation must not become the reason a query fails.
		}
	};

	const ended = (
		requestId: number,
		failure: unknown,
		duration: number,
	): void => {
		try {
			const found = inFlight.get(requestId);
			if (found === undefined) return;
			inFlight.delete(requestId);

			found.telemetry.emit(record(found, failure, duration));
		} catch {
			// As above.
		}
	};

	const succeeded = (event: CommandSucceededEvent): void =>
		ended(event.requestId, undefined, event.duration);
	const failed = (event: CommandFailedEvent): void =>
		ended(event.requestId, event.failure, event.duration);

	client.on('commandStarted', started);
	client.on('commandSucceeded', succeeded);
	client.on('commandFailed', failed);

	return () => {
		client.off('commandStarted', started);
		client.off('commandSucceeded', succeeded);
		client.off('commandFailed', failed);
		inFlight.clear();
	};
}

/**
 * The span, built rather than opened.
 *
 * The driver reports the command's own `duration`, which is closer to what the
 * server spent than the wall clock between two events on a busy loop, so the
 * start is derived from the end rather than the other way round.
 */
function record(
	found: InFlight,
	failure: unknown,
	duration: number,
): SpanRecord {
	const endedAt = Date.now();
	const startedAt = Math.min(endedAt - Math.max(duration, 0), found.startedAt);

	return {
		type: 'span',
		name: found.name,
		context: found.context,
		...(found.parent === undefined ? {} : { parent: found.parent.spanId }),
		kind: 'client',
		startedAt,
		endedAt,
		status:
			failure === undefined ? 'ok' : isAbort(failure) ? 'cancelled' : 'error',
		attributes: found.attributes,
		events: [],
		...(failure === undefined
			? {}
			: { error: errorInfo(failure, found.telemetry.stackTraces) }),
	};
}

/**
 * The span's place in a trace, decided when the command starts.
 *
 * A command inside a request inherits that request's trace **and its sampling
 * decision** — sampling is decided once, by the root, and a sampler asked again
 * per span produces traces missing their middles. A command with nothing above
 * it *is* a root, so it asks the sampler exactly as `span()` would.
 */
function contextFor(
	telemetry: Telemetry,
	parent: SpanContext | undefined,
): SpanContext {
	if (parent !== undefined) {
		return {
			traceId: parent.traceId,
			spanId: randomSpanId(),
			sampled: parent.sampled,
			remote: false,
		};
	}

	const traceId = randomTraceId();
	return {
		traceId,
		spanId: randomSpanId(),
		sampled: sampled(telemetry, traceId),
		remote: false,
	};
}

function sampled(telemetry: Telemetry, traceId: TraceId): boolean {
	try {
		return telemetry.sampler.sample(traceId);
	} catch {
		// A sampler that throws must not cost the command; keeping the span is
		// the answer that loses nothing.
		return true;
	}
}

/**
 * Through `attributesOf`, which is total: an address a driver reports as
 * something unexpected is rendered rather than thrown over.
 */
function attributesFor(event: CommandStartedEvent): Attributes {
	const collection = collectionOf(event);
	const [host, port] = split(event.address);

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

function defaultName(event: CommandStartedEvent): string {
	const collection = collectionOf(event);
	return `${event.commandName} ${collection ?? event.databaseName}`;
}

function notADriverCommand(event: CommandStartedEvent): boolean {
	return !DRIVER_COMMANDS.has(event.commandName);
}

/** `host:port`, and an IPv6 literal, and a unix socket path. */
function split(address: string): [string | undefined, number | undefined] {
	if (typeof address !== 'string' || address === '')
		return [undefined, undefined];

	const colon = address.lastIndexOf(':');
	if (colon <= 0) return [address, undefined];

	const port = Number(address.slice(colon + 1));
	return Number.isInteger(port)
		? [address.slice(0, colon), port]
		: [address, undefined];
}

/** Drops the oldest entry once the map is full. Insertion order is age. */
function forget(inFlight: Map<number, InFlight>): void {
	if (inFlight.size < MAX_IN_FLIGHT) return;

	const oldest = inFlight.keys().next();
	if (!oldest.done) inFlight.delete(oldest.value);
}
