import type { Resource, Signal } from '@nxgt/telemetry';

/**
 * A signal as it is stored.
 *
 * It is the signal, with three changes and no others:
 *
 * - **every instant becomes a BSON `Date`**, so a query can use a range and a
 *   TTL index can expire it. Stored as an epoch number it would be neither;
 * - **the resource is stamped on each document** — `service`, `version`,
 *   `environment` — because a collection here is shared by every service that
 *   writes to it, which is the opposite of a log file;
 * - **`at` exists on both kinds.** A span is stamped with its start, so one
 *   index answers "what happened in this minute" for logs and spans alike, and
 *   one TTL index expires both.
 */
export interface SignalDocument {
	readonly at: Date;
	readonly service: string;
	readonly version?: string;
	readonly environment?: string;
	readonly [field: string]: unknown;
}

/** Epoch milliseconds to a BSON `Date`, and nothing else touched. */
export function documentOf(resource: Resource, signal: Signal): SignalDocument {
	const stamped = {
		service: resource.service,
		...(resource.version === undefined ? {} : { version: resource.version }),
		...(resource.environment === undefined
			? {}
			: { environment: resource.environment }),
	};

	return signal.type === 'log'
		? { ...signal, ...stamped, at: new Date(signal.at) }
		: {
				...signal,
				...stamped,
				at: new Date(signal.startedAt),
				startedAt: new Date(signal.startedAt),
				endedAt: new Date(signal.endedAt),
				events: signal.events.map((happened) => ({
					...happened,
					at: new Date(happened.at),
				})),
			};
}
