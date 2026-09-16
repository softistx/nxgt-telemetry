import type { Attributes } from '../attributes/attributes';
import type { SpanContext, SpanId } from '../trace/ids';

/**
 * The signal model. It is shared with `stx-telemetry`, the Kotlin counterpart:
 * the same four severities, the same span kinds and statuses, the same
 * discriminator. Changing anything here means the two estates have diverged.
 *
 * Instants are epoch **milliseconds**, which is the precision a JavaScript wall
 * clock has. OTLP wants nanoseconds, and the exporter multiplies.
 */

/**
 * Four levels, and there is no `trace`: detail below `debug` is an attribute on
 * a span, where it is attached to the work it describes rather than to a line
 * somebody has to correlate by hand.
 */
export type Severity = 'debug' | 'info' | 'warn' | 'error';

/** OTLP's numbers, which is what makes a backend order them correctly. */
export const SEVERITY_NUMBER: Readonly<Record<Severity, number>> =
	Object.freeze({
		debug: 5,
		info: 9,
		warn: 13,
		error: 17,
	});

/** Ascending, so a floor can be compared by index as well as by number. */
export const SEVERITIES: readonly Severity[] = Object.freeze([
	'debug',
	'info',
	'warn',
	'error',
] as const);

/** Whether `severity` clears the `minimum` floor. */
export function meetsSeverity(severity: Severity, minimum: Severity): boolean {
	return SEVERITY_NUMBER[severity] >= SEVERITY_NUMBER[minimum];
}

export type SpanKind =
	| 'internal'
	| 'server'
	| 'client'
	| 'producer'
	| 'consumer';

export const SPAN_KIND_NUMBER: Readonly<Record<SpanKind, number>> =
	Object.freeze({
		internal: 1,
		server: 2,
		client: 3,
		producer: 4,
		consumer: 5,
	});

/**
 * `cancelled` is distinct from `error` on purpose: a shutdown and a timeout are
 * not failures, and a dashboard that counts them as such is a dashboard nobody
 * trusts.
 */
export type SpanStatus = 'ok' | 'error' | 'cancelled';

/** What every signal from one telemetry is about. */
export interface Resource {
	readonly service: string;
	readonly version?: string;
	readonly environment?: string;
	readonly attributes: Attributes;
}

/** A failure, flattened: the stack is text, because it crosses the wire. */
export interface ErrorInfo {
	readonly type: string;
	readonly message?: string;
	readonly stackTrace?: string;
}

export interface LogRecord {
	readonly type: 'log';
	/** Epoch milliseconds. */
	readonly at: number;
	readonly severity: Severity;
	/** The event's name, or the message when there is no type for it yet. */
	readonly name: string;
	/** The logger's name. It becomes the OTLP instrumentation scope. */
	readonly source: string;
	readonly attributes: Attributes;
	/** Absent for a log written outside any span. */
	readonly span?: SpanContext;
	readonly error?: ErrorInfo;
}

export interface SpanEvent {
	readonly name: string;
	/** Epoch milliseconds. */
	readonly at: number;
	readonly attributes: Attributes;
}

export interface SpanRecord {
	readonly type: 'span';
	readonly name: string;
	readonly context: SpanContext;
	/** Absent for a root span. */
	readonly parent?: SpanId;
	readonly kind: SpanKind;
	/** Epoch milliseconds. */
	readonly startedAt: number;
	/** Epoch milliseconds. */
	readonly endedAt: number;
	readonly status: SpanStatus;
	readonly attributes: Attributes;
	readonly events: readonly SpanEvent[];
	readonly error?: ErrorInfo;
}

/**
 * The discriminator is the field `type`, with the values `"log"` and `"span"`.
 * It is not a class name, so that metrics can arrive as a third variant without
 * anything in the model or in the `Exporter` contract changing.
 */
export type Signal = LogRecord | SpanRecord;

/** When a signal happened, whichever kind it is. */
export function signalAt(signal: Signal): number {
	return signal.type === 'log' ? signal.at : signal.startedAt;
}

/** The span a signal belongs to, whichever kind it is. */
export function signalSpan(signal: Signal): SpanContext | undefined {
	return signal.type === 'log' ? signal.span : signal.context;
}
