import { currentSpan, resolveTelemetry, type Telemetry } from '@nxgt/telemetry';
import type {
	CommandFailedEvent,
	CommandStartedEvent,
	CommandSucceededEvent,
	MongoClient,
} from 'mongodb';
import { commandAttributes, commandName } from '../attributes/db';
import { contextFor, type InFlight, spanOf } from './record';

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
	const named = options.spanName ?? commandName;
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
				attributes: commandAttributes(event),
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

			found.telemetry.emit(spanOf(found, failure, duration));
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

function notADriverCommand(event: CommandStartedEvent): boolean {
	return !DRIVER_COMMANDS.has(event.commandName);
}

/** Drops the oldest entry once the map is full. Insertion order is age. */
function forget(inFlight: Map<number, InFlight>): void {
	if (inFlight.size < MAX_IN_FLIGHT) return;

	const oldest = inFlight.keys().next();
	if (!oldest.done) inFlight.delete(oldest.value);
}
