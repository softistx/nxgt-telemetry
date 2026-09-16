import type {
	Attributes,
	AttributeValue,
	ErrorInfo,
	LogRecord,
	Resource,
	Signal,
	SpanRecord,
	SpanStatus,
} from '@nxgt/telemetry';
import { SEVERITY_NUMBER, SPAN_KIND_NUMBER } from '@nxgt/telemetry';
import type {
	AnyValue,
	ExportLogsServiceRequest,
	ExportTraceServiceRequest,
	KeyValue,
	OtlpLogRecord,
	OtlpResource,
	OtlpSpan,
	OtlpSpanEvent,
	ScopeLogs,
} from './documents';

/** The instrumentation scope reported for spans. Logs report their `source`. */
export const SPAN_SCOPE = 'nxgt-telemetry';

/**
 * `ok` maps to `1` and `error` to `2`, and **`cancelled` maps to `0`** — unset,
 * not error. A shutdown and a timeout are not failures, and a dashboard that
 * counts them as such is a dashboard nobody trusts; OTLP has no third code, so
 * the honest answer is to say nothing rather than to say "failed".
 */
export const STATUS_CODE: Readonly<Record<SpanStatus, number>> = Object.freeze({
	ok: 1,
	error: 2,
	cancelled: 0,
});

/**
 * Epoch milliseconds to the decimal nanoseconds OTLP wants, through `BigInt`.
 *
 * A `number` would be wrong from 2001 onwards: `Date.now() * 1e6` is well past
 * `Number.MAX_SAFE_INTEGER`, so the last digits are whatever the float rounds
 * to, and two signals a microsecond apart arrive with the same timestamp.
 */
export function nanos(at: number): string {
	return (BigInt(Math.round(at)) * 1_000_000n).toString();
}

/** A scalar, tagged the way OTLP tags it. */
export function anyValue(value: AttributeValue): AnyValue {
	if (value === null) return {};
	if (typeof value === 'string') return { stringValue: value };
	if (typeof value === 'boolean') return { boolValue: value };

	if (typeof value === 'number') {
		// A whole number is an integer to every backend that groups by it, and
		// it crosses as text so that the low bits survive.
		//
		// **Safe**, not merely whole: `Number.isInteger` is true well past the
		// safe range, and `String` switches to exponential notation at 1e21.
		// `1e21` would be sent as `"1e+21"`, which is not the decimal string
		// OTLP asks for; `1e20` is decimal but past `int64`; and `2 ** 60`
		// would arrive with the wrong last three digits. A collector rejects
		// the first two with a `400`, which is not retried — so one attribute
		// would lose the whole document. Past the safe range the honest answer
		// is a double, which is all the precision the value had anyway.
		return Number.isSafeInteger(value)
			? { intValue: String(value) }
			: { doubleValue: value };
	}

	return { arrayValue: { values: value.map(anyValue) } };
}

export function keyValues(attributes: Attributes): KeyValue[] {
	return Object.keys(attributes).map((key) => ({
		key,
		value: anyValue(attributes[key] as AttributeValue),
	}));
}

/**
 * The resource, with `service.name`, `service.version` and
 * `deployment.environment.name` — the three keys every backend looks for, under
 * the names the semantic conventions give them. An attribute already carrying
 * one of those keys wins: it was set deliberately.
 */
export function otlpResource(resource: Resource): OtlpResource {
	const declared: Record<string, AttributeValue> = {
		'service.name': resource.service,
	};
	if (resource.version !== undefined) {
		declared['service.version'] = resource.version;
	}
	if (resource.environment !== undefined) {
		declared['deployment.environment.name'] = resource.environment;
	}

	return { attributes: keyValues({ ...declared, ...resource.attributes }) };
}

/**
 * The logs of a batch, **grouped by `source`** into one scope each: the logger's
 * name is the instrumentation scope, which is what lets a backend filter by the
 * component that wrote the line rather than by the service that ran it.
 *
 * `undefined` when there is nothing to send — an empty document is a request
 * worth not making.
 */
export function logsRequest(
	resource: Resource,
	batch: readonly Signal[],
): ExportLogsServiceRequest | undefined {
	const bySource = new Map<string, OtlpLogRecord[]>();

	for (const signal of batch) {
		if (signal.type !== 'log') continue;
		const found = bySource.get(signal.source) ?? [];
		found.push(otlpLog(signal));
		bySource.set(signal.source, found);
	}

	if (bySource.size === 0) return undefined;

	const scopeLogs: ScopeLogs[] = [...bySource].map(([name, logRecords]) => ({
		scope: { name },
		logRecords,
	}));

	return { resourceLogs: [{ resource: otlpResource(resource), scopeLogs }] };
}

/**
 * The spans of a batch, in one scope named for this library. A span has no
 * `source` — it is named for the work, not for the component — so there is
 * nothing to group by.
 */
export function tracesRequest(
	resource: Resource,
	batch: readonly Signal[],
): ExportTraceServiceRequest | undefined {
	const spans = batch
		.filter((signal): signal is SpanRecord => signal.type === 'span')
		.map(otlpSpan);

	if (spans.length === 0) return undefined;

	return {
		resourceSpans: [
			{
				resource: otlpResource(resource),
				scopeSpans: [{ scope: { name: SPAN_SCOPE }, spans }],
			},
		],
	};
}

function otlpLog(log: LogRecord): OtlpLogRecord {
	const at = nanos(log.at);

	return {
		timeUnixNano: at,
		// The same instant: this library records when the line was written, and
		// has nothing else to observe it at.
		observedTimeUnixNano: at,
		severityNumber: SEVERITY_NUMBER[log.severity],
		severityText: log.severity.toUpperCase(),
		// The body is the event's name, or the message when there is no type
		// for it yet. Everything structured is an attribute.
		body: { stringValue: log.name },
		attributes: keyValues({ ...log.attributes, ...exception(log.error) }),
		...(log.span === undefined
			? {}
			: {
					traceId: log.span.traceId,
					spanId: log.span.spanId,
					flags: log.span.sampled ? 1 : 0,
				}),
	};
}

function otlpSpan(span: SpanRecord): OtlpSpan {
	return {
		traceId: span.context.traceId,
		spanId: span.context.spanId,
		...(span.parent === undefined ? {} : { parentSpanId: span.parent }),
		name: span.name,
		kind: SPAN_KIND_NUMBER[span.kind],
		startTimeUnixNano: nanos(span.startedAt),
		endTimeUnixNano: nanos(span.endedAt),
		attributes: keyValues({ ...span.attributes, ...exception(span.error) }),
		events: span.events.map(
			(happened): OtlpSpanEvent => ({
				timeUnixNano: nanos(happened.at),
				name: happened.name,
				attributes: keyValues(happened.attributes),
			}),
		),
		status: {
			code: STATUS_CODE[span.status],
			...(span.error?.message === undefined
				? {}
				: { message: span.error.message }),
		},
	};
}

/**
 * A failure travels as attributes, under the semantic convention's keys, on a
 * log and on a span alike. There is no dedicated field for it in either
 * document.
 */
function exception(error: ErrorInfo | undefined): Attributes {
	if (error === undefined) return {};

	return {
		'exception.type': error.type,
		...(error.message === undefined
			? {}
			: { 'exception.message': error.message }),
		...(error.stackTrace === undefined
			? {}
			: { 'exception.stacktrace': error.stackTrace }),
	};
}
