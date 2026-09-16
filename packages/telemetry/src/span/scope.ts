import {
	type Attributes,
	type AttributeValue,
	attributesOf,
	coerceAttribute,
	mergeAttributes,
} from '../attributes/attributes';
import { isTelemetryEvent, type TelemetryEvent } from '../logger/event';
import { errorInfo, isAbort } from '../model/error';
import type {
	ErrorInfo,
	SpanEvent,
	SpanKind,
	SpanRecord,
	SpanStatus,
} from '../model/signal';
import {
	renderTraceparent,
	type SpanContext,
	type SpanId,
	type TraceId,
} from '../trace/ids';

/** The open span, from inside it. Everything here is synchronous. */
export interface SpanScope {
	readonly context: SpanContext;
	readonly traceId: TraceId;
	readonly spanId: SpanId;
	/** Writable: a server span is named after its route, which routing knows last. */
	name: string;
	/** Writable, for work that failed without throwing. An exception overrides it. */
	status: SpanStatus;
	/** The header an outgoing call should carry to continue this trace. */
	traceparent(): string;
	attribute(name: string, value: unknown): void;
	attributes(record: Readonly<Record<string, unknown>>): void;
	event(name: string, attributes?: Readonly<Record<string, unknown>>): void;
	event(event: TelemetryEvent): void;
}

/**
 * The open span.
 *
 * Every method is synchronous and none of them can throw: they are called from
 * application code that is already in trouble, and a span that raised would
 * replace the failure it was opened to record.
 */
export class Span implements SpanScope {
	name: string;
	status: SpanStatus = 'ok';
	readonly context: SpanContext;

	private readonly kind: SpanKind;
	private readonly own: Record<string, AttributeValue> = {};
	private readonly happened: SpanEvent[] = [];
	private error: ErrorInfo | undefined;

	constructor(context: SpanContext, name: string, kind: SpanKind) {
		this.context = context;
		this.name = name;
		this.kind = kind;
	}

	get traceId(): TraceId {
		return this.context.traceId;
	}

	get spanId(): SpanId {
		return this.context.spanId;
	}

	traceparent(): string {
		return renderTraceparent(this.context);
	}

	attribute(name: string, value: unknown): void {
		this.own[name] = coerceAttribute(value);
	}

	attributes(record: Readonly<Record<string, unknown>>): void {
		Object.assign(this.own, attributesOf(record));
	}

	event(
		input: string | TelemetryEvent,
		attributes?: Readonly<Record<string, unknown>>,
	): void {
		const declared = isTelemetryEvent(input);
		this.happened.push({
			name: declared ? input.name : input,
			at: Date.now(),
			attributes: declared ? input.attributes : attributesOf(attributes),
		});
	}

	fail(failure: unknown, stackTraces: boolean): void {
		const cancelled = isAbort(failure);
		this.status = cancelled ? 'cancelled' : 'error';
		this.error = errorInfo(failure, !cancelled && stackTraces);
	}

	/**
	 * The record that is emitted. Both collections are **copied**: a scope that
	 * outlives its block — held by a callback, or by a caller that kept it —
	 * would otherwise mutate a record already sitting in the pipeline buffer.
	 * The attributes case is the easy one to miss, because `mergeAttributes`
	 * returns one side unchanged when the other is empty.
	 */
	record(
		startedAt: number,
		endedAt: number,
		parent: SpanId | undefined,
		inherited: Attributes,
	): SpanRecord {
		return {
			type: 'span',
			name: this.name,
			context: this.context,
			...(parent === undefined ? {} : { parent }),
			kind: this.kind,
			startedAt,
			endedAt,
			status: this.status,
			attributes: { ...mergeAttributes(inherited, this.own) },
			events: [...this.happened],
			...(this.error === undefined ? {} : { error: this.error }),
		};
	}
}
