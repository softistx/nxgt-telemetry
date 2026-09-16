import {
	type Attributes,
	type Resource,
	type Signal,
	signalAt,
	signalSpan,
} from '@nxgt/telemetry';

/**
 * A signal as it is stored.
 *
 * It is the signal, with four changes and no others:
 *
 * - **every instant becomes a BSON `Date`**, so a query can use a range and a
 *   TTL index can expire it. Stored as an epoch number it would be neither;
 * - **the resource is stamped on each document** — `service`, `version`,
 *   `environment`, and its attributes under `resource` — because a collection
 *   here is shared by every service that writes to it, which is the opposite of
 *   a log file;
 * - **`traceId` and `spanId` are lifted to the top level.** They live at
 *   `span.traceId` on a log and at `context.traceId` on a span, so without this
 *   the one query anybody actually writes — everything in this trace — would
 *   need an `$or` over two paths and an index on each;
 * - **`at` exists on both kinds.** A span is stamped with its start, so one
 *   index answers "what happened in this minute" for logs and spans alike, and
 *   one TTL index expires both.
 */
export interface SignalDocument {
	readonly at: Date;
	readonly service: string;
	readonly version?: string;
	readonly environment?: string;
	readonly resource?: Attributes;
	readonly traceId?: string;
	readonly spanId?: string;
	readonly [field: string]: unknown;
}

/** Epoch milliseconds to a BSON `Date`, and nothing else touched. */
export function documentOf(resource: Resource, signal: Signal): SignalDocument {
	const span = signalSpan(signal);

	const stamped = {
		service: resource.service,
		...(resource.version === undefined ? {} : { version: resource.version }),
		...(resource.environment === undefined
			? {}
			: { environment: resource.environment }),
		// A sub-document rather than flattened beside them: a resource
		// attribute is named by whoever configured the service, and one called
		// `name` or `type` flattened here would overwrite the signal's own.
		...(hasAny(resource.attributes) ? { resource: resource.attributes } : {}),
		...(span === undefined
			? {}
			: { traceId: span.traceId as string, spanId: span.spanId as string }),
		at: new Date(signalAt(signal)),
	};

	return signal.type === 'log'
		? { ...signal, ...stamped }
		: {
				...signal,
				...stamped,
				startedAt: new Date(signal.startedAt),
				endedAt: new Date(signal.endedAt),
				events: signal.events.map((happened) => ({
					...happened,
					at: new Date(happened.at),
				})),
			};
}

function hasAny(attributes: Attributes): boolean {
	return Object.keys(attributes).length > 0;
}
