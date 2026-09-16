/**
 * Trace identity, and the W3C `traceparent` header.
 *
 * The ids are branded strings: the hex representation is the representation, so
 * there is nothing to allocate and nothing to convert before writing a header,
 * and the brand still stops a span id being passed where a trace id belongs.
 */

declare const traceIdBrand: unique symbol;
declare const spanIdBrand: unique symbol;

/** 32 lowercase hex characters. */
export type TraceId = string & { readonly [traceIdBrand]: true };

/** 16 lowercase hex characters. */
export type SpanId = string & { readonly [spanIdBrand]: true };

export const INVALID_TRACE_ID = '0'.repeat(32) as TraceId;
export const INVALID_SPAN_ID = '0'.repeat(16) as SpanId;

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const HEX_PATTERN = /^[0-9a-f]+$/;

export function isValidTraceId(hex: string): hex is TraceId {
	return TRACE_ID_PATTERN.test(hex) && hex !== INVALID_TRACE_ID;
}

export function isValidSpanId(hex: string): hex is SpanId {
	return SPAN_ID_PATTERN.test(hex) && hex !== INVALID_SPAN_ID;
}

/**
 * From `crypto.getRandomValues`, never `Math.random()`: ids that collide join
 * two unrelated traces into one, which reads as a request that did work it
 * never did.
 */
export function randomTraceId(): TraceId {
	return randomHex(16) as TraceId;
}

export function randomSpanId(): SpanId {
	return randomHex(8) as SpanId;
}

/** A span's place in a trace, as it travels. */
export interface SpanContext {
	readonly traceId: TraceId;
	readonly spanId: SpanId;
	/** Decided once, by the root, and inherited by everything below it. */
	readonly sampled: boolean;
	/** True when this context was parsed from an inbound header. */
	readonly remote: boolean;
}

/**
 * What a span carries when there is no telemetry installed. The block still
 * runs — a library that traces must work inside an application that has never
 * heard of this one — and nothing is emitted.
 */
export const DETACHED_SPAN_CONTEXT: SpanContext = Object.freeze({
	traceId: INVALID_TRACE_ID,
	spanId: INVALID_SPAN_ID,
	sampled: false,
	remote: false,
});

export function isDetached(context: SpanContext): boolean {
	return !isValidTraceId(context.traceId);
}

/** `00-<trace id>-<span id>-<flags>`, version 00, the only one we write. */
export function renderTraceparent(context: SpanContext): string {
	return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

/**
 * The inbound half. It **returns null, and never throws**: an unusable header
 * is a request that starts a fresh trace, not a request that fails.
 *
 * Rejected: fewer than four fields, a version that is not two characters, the
 * forbidden version `ff`, an id of the wrong length or all zeros or not hex,
 * and flags that are not hex. A later version is accepted and its extra fields
 * ignored, which is what the specification asks of a version-00 reader.
 *
 * `tracestate` is not read. Nothing here writes one either.
 */
export function parseTraceparent(
	header: string | null | undefined,
): SpanContext | null {
	if (!header) return null;

	const parts = header.trim().toLowerCase().split('-');
	if (parts.length < 4) return null;

	const [version, traceId, spanId, flags] = parts as [
		string,
		string,
		string,
		string,
	];

	if (version.length !== 2 || !HEX_PATTERN.test(version) || version === 'ff') {
		return null;
	}
	if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) return null;
	if (!HEX_PATTERN.test(flags)) return null;

	const parsed = Number.parseInt(flags, 16);
	if (Number.isNaN(parsed)) return null;

	return {
		traceId,
		spanId,
		sampled: (parsed & 0x01) === 0x01,
		remote: true,
	};
}

const HEX = '0123456789abcdef';

function randomHex(bytes: number): string {
	const buffer = new Uint8Array(bytes);
	crypto.getRandomValues(buffer);

	let hex = '';
	for (const byte of buffer) {
		hex += HEX[byte >> 4];
		hex += HEX[byte & 0x0f];
	}
	return hex;
}
