import {
	attributesOf,
	EMPTY_ATTRIBUTES,
	mergeAttributes,
} from '../attributes/attributes';
import { currentContext, runWithContext } from '../context/current';
import type { SpanKind } from '../model/signal';
import { installedTelemetry, type Telemetry } from '../telemetry/telemetry';
import {
	DETACHED_SPAN_CONTEXT,
	parseTraceparent,
	randomSpanId,
	randomTraceId,
	type SpanContext,
	type TraceId,
} from '../trace/ids';
import { Span, type SpanScope } from './scope';

export interface SpanOptions {
	/** Inherited by every log and span inside this one. */
	readonly attributes?: Readonly<Record<string, unknown>>;
	readonly kind?: SpanKind;
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
 * **It never swallows.** A failure marks the span and is rethrown, exactly as
 * it arrived; a span observes, it does not handle.
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
		// Recording must never become the reason the caller's failure is lost,
		// so nothing in here may raise in its place.
		try {
			scope.fail(failure, telemetry.stackTraces);
		} catch {
			scope.status = 'error';
		}
		throw failure;
	} finally {
		if (context.sampled) {
			telemetry.emit(
				scope.record(startedAt, Date.now(), parentSpan?.spanId, inherited),
			);
		}
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
