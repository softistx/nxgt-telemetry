import {
	type Attributes,
	errorInfo,
	isAbort,
	randomSpanId,
	randomTraceId,
	type SpanContext,
	type SpanRecord,
	type Telemetry,
	type TraceId,
} from '@nxgt/telemetry';

/** A command that has started and whose reply has not arrived yet. */
export interface InFlight {
	readonly telemetry: Telemetry;
	readonly parent: SpanContext | undefined;
	readonly context: SpanContext;
	readonly name: string;
	readonly attributes: Attributes;
	readonly startedAt: number;
}

/**
 * The span, built rather than opened.
 *
 * The driver reports the command's own `duration`, which is closer to what the
 * server spent than the wall clock between two events on a busy loop, so the
 * start is derived from the end rather than the other way round.
 */
export function spanOf(
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
export function contextFor(
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
