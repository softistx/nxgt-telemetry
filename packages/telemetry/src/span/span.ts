import {
	type Attributes,
	type AttributeValue,
	attributesOf,
	coerceAttribute,
	EMPTY_ATTRIBUTES,
	mergeAttributes,
} from '../attributes/attributes';
import { currentContext, runWithContext } from '../context/current';
import { isTelemetryEvent, type TelemetryEvent } from '../logger/event';
import { errorInfo, isAbort } from '../model/error';
import type {
	ErrorInfo,
	SpanEvent,
	SpanKind,
	SpanRecord,
	SpanStatus,
} from '../model/signal';
import { installedTelemetry, type Telemetry } from '../telemetry/telemetry';
import {
	DETACHED_SPAN_CONTEXT,
	parseTraceparent,
	randomSpanId,
	randomTraceId,
	renderTraceparent,
	type SpanContext,
	type SpanId,
	type TraceId,
} from '../trace/ids';

export interface SpanOptions {
	/** Inherited by every log and span inside this one. */
	readonly attributes?: Readonly<Record<string, unknown>>;
	readonly kind?: SpanKind;
}

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

export type SpanBlock<T> = (scope: SpanScope) => T | Promise<T>;

export function span<T>(name: string, block: SpanBlock<T>): Promise<T>;
export function span<T>(
	name: string,
	options: SpanOptions,
	block: SpanBlock<T>,
): Promise<T>;

/**
 * ```ts
 * await span('charge', { attributes: { orderId } }, async (scope) => {
 *   scope.event('gateway.called');
 *   await payments.charge(card);
 * });
 * ```
 *
 * The block runs whether or not a telemetry is installed: a library that traces
 * must work inside an application that has never heard of this one. With none,
 * the scope carries a detached context and nothing is emitted.
 *
 * **It never swallows.** A failure marks the span and is rethrown; a span
 * observes, it does not handle.
 */
export function span<T>(
	name: string,
	optionsOrBlock: SpanOptions | SpanBlock<T>,
	maybeBlock?: SpanBlock<T>,
): Promise<T> {
	const [options, block] = read(optionsOrBlock, maybeBlock);
	return open(name, options, block, undefined, 'internal');
}

export function continuing<T>(
	traceparent: string | null | undefined,
	name: string,
	block: SpanBlock<T>,
): Promise<T>;
export function continuing<T>(
	traceparent: string | null | undefined,
	name: string,
	options: SpanOptions,
	block: SpanBlock<T>,
): Promise<T>;

/**
 * The same, continuing a trace an inbound `traceparent` started.
 *
 * An unusable header is not an error: it starts a fresh trace, exactly as
 * `span` would. That matters because the header comes from a stranger.
 */
export function continuing<T>(
	traceparent: string | null | undefined,
	name: string,
	optionsOrBlock: SpanOptions | SpanBlock<T>,
	maybeBlock?: SpanBlock<T>,
): Promise<T> {
	const [options, block] = read(optionsOrBlock, maybeBlock);
	const remote = parseTraceparent(traceparent) ?? undefined;
	return open(name, options, block, remote, 'server');
}

async function open<T>(
	name: string,
	options: SpanOptions,
	block: SpanBlock<T>,
	remote: SpanContext | undefined,
	fallbackKind: SpanKind,
): Promise<T> {
	const parent = currentContext();
	const telemetry = parent?.telemetry ?? installedTelemetry();
	const kind = options.kind ?? fallbackKind;

	if (telemetry === undefined) {
		return block(new Span(DETACHED_SPAN_CONTEXT, name, kind));
	}

	// A remote parent wins over an ambient one: the caller's trace is the trace.
	const parentSpan = remote ?? parent?.span;
	const traceId = parentSpan?.traceId ?? randomTraceId();
	const context: SpanContext = {
		traceId,
		spanId: randomSpanId(),
		// Asked once, by the root. Below one, the answer is inherited, which is
		// what keeps a trace whole instead of missing its middle.
		sampled: parentSpan?.sampled ?? decide(telemetry, traceId),
		remote: false,
	};

	const inherited = mergeAttributes(
		parent?.attributes ?? EMPTY_ATTRIBUTES,
		attributesOf(options.attributes),
	);
	const scope = new Span(context, name, kind);
	const startedAt = Date.now();

	try {
		return await runWithContext(
			{ telemetry, span: context, attributes: inherited },
			() => block(scope),
		);
	} catch (failure) {
		scope.fail(failure, telemetry.stackTraces);
		throw failure;
	} finally {
		if (context.sampled) {
			telemetry.emit(
				scope.record(startedAt, Date.now(), parentSpan?.spanId, inherited),
			);
		}
	}
}

/** The open span. Every method is synchronous, and none of them can throw. */
class Span implements SpanScope {
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
			attributes: mergeAttributes(inherited, this.own),
			events: [...this.happened],
			...(this.error === undefined ? {} : { error: this.error }),
		};
	}
}

function read<T>(
	optionsOrBlock: SpanOptions | SpanBlock<T>,
	maybeBlock: SpanBlock<T> | undefined,
): [SpanOptions, SpanBlock<T>] {
	return typeof optionsOrBlock === 'function'
		? [{}, optionsOrBlock]
		: [optionsOrBlock, maybeBlock as SpanBlock<T>];
}

/**
 * A sampler is written by whoever uses this library, so it can throw. Opening a
 * span is not allowed to fail because of it: an unsampled trace loses a
 * dashboard, a thrown sampler loses a request.
 */
function decide(telemetry: Telemetry, traceId: TraceId): boolean {
	try {
		return telemetry.sampler.sample(traceId);
	} catch {
		return false;
	}
}
