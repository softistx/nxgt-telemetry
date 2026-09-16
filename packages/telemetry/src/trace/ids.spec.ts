import { describe, expect, test } from 'bun:test';
import {
	DETACHED_SPAN_CONTEXT,
	INVALID_SPAN_ID,
	INVALID_TRACE_ID,
	isDetached,
	isValidSpanId,
	isValidTraceId,
	parseTraceparent,
	randomSpanId,
	randomTraceId,
	renderTraceparent,
	type SpanContext,
} from './ids';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

describe('random ids', () => {
	test('are the right length, lowercase hex, and valid', () => {
		const traceId = randomTraceId();
		const spanId = randomSpanId();

		expect(traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(isValidTraceId(traceId)).toBe(true);
		expect(isValidSpanId(spanId)).toBe(true);
	});

	test('do not repeat', () => {
		const ids = new Set(Array.from({ length: 512 }, () => randomTraceId()));
		expect(ids.size).toBe(512);
	});
});

describe('validity', () => {
	test('rejects the wrong length, the wrong alphabet and all zeros', () => {
		expect(isValidTraceId(TRACE)).toBe(true);
		expect(isValidTraceId(SPAN)).toBe(false);
		expect(isValidTraceId(TRACE.toUpperCase())).toBe(false);
		expect(isValidTraceId(INVALID_TRACE_ID)).toBe(false);
		expect(isValidSpanId(INVALID_SPAN_ID)).toBe(false);
		expect(isValidSpanId('00f067aa0ba902bg')).toBe(false);
	});
});

describe('renderTraceparent', () => {
	test('writes version 00, and the sampled flag', () => {
		const context: SpanContext = {
			traceId: TRACE as SpanContext['traceId'],
			spanId: SPAN as SpanContext['spanId'],
			sampled: true,
			remote: false,
		};

		expect(renderTraceparent(context)).toBe(`00-${TRACE}-${SPAN}-01`);
		expect(renderTraceparent({ ...context, sampled: false })).toBe(
			`00-${TRACE}-${SPAN}-00`,
		);
	});

	test('round-trips through the parser', () => {
		const context: SpanContext = {
			traceId: randomTraceId(),
			spanId: randomSpanId(),
			sampled: true,
			remote: false,
		};

		expect(parseTraceparent(renderTraceparent(context))).toEqual({
			...context,
			remote: true,
		});
	});
});

/**
 * Every rejection rule gets its own case. An unusable header must start a fresh
 * trace, so the parser returns null and never throws: a caller who has to
 * try/catch around reading a request header will not, and the request will 500
 * on a header a stranger controls.
 */
describe('parseTraceparent rejects', () => {
	const rejected: Record<string, string | null | undefined> = {
		'nothing at all': undefined,
		'an empty header': '',
		'fewer than four fields': `00-${TRACE}-${SPAN}`,
		'a version that is not two characters': `0-${TRACE}-${SPAN}-01`,
		'a version that is not hex': `0g-${TRACE}-${SPAN}-01`,
		'the forbidden version ff': `ff-${TRACE}-${SPAN}-01`,
		'a trace id of the wrong length': `00-${TRACE.slice(1)}-${SPAN}-01`,
		'a trace id that is all zeros': `00-${INVALID_TRACE_ID}-${SPAN}-01`,
		'a trace id that is not hex': `00-${TRACE.slice(0, 31)}z-${SPAN}-01`,
		'a span id of the wrong length': `00-${TRACE}-${SPAN.slice(1)}-01`,
		'a span id that is all zeros': `00-${TRACE}-${INVALID_SPAN_ID}-01`,
		'flags that are not hex': `00-${TRACE}-${SPAN}-zz`,
	};

	for (const [why, header] of Object.entries(rejected)) {
		test(why, () => {
			expect(parseTraceparent(header)).toBeNull();
		});
	}
});

describe('parseTraceparent accepts', () => {
	test('an uppercase header, because the ids are compared lowercased', () => {
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`.toUpperCase())).toEqual({
			traceId: TRACE as SpanContext['traceId'],
			spanId: SPAN as SpanContext['spanId'],
			sampled: true,
			remote: true,
		});
	});

	test('a later version, ignoring its extra fields', () => {
		expect(parseTraceparent(`01-${TRACE}-${SPAN}-01-extra`)).toEqual({
			traceId: TRACE as SpanContext['traceId'],
			spanId: SPAN as SpanContext['spanId'],
			sampled: true,
			remote: true,
		});
	});

	test('surrounding whitespace', () => {
		expect(parseTraceparent(`  00-${TRACE}-${SPAN}-00  `)?.sampled).toBe(false);
	});

	test('a flags field with bits we do not know', () => {
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-ff`)?.sampled).toBe(true);
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-fe`)?.sampled).toBe(false);
	});

	test('and marks what it parsed as remote', () => {
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-01`)?.remote).toBe(true);
	});
});

describe('the detached context', () => {
	test('is what a span carries with no telemetry installed', () => {
		expect(isDetached(DETACHED_SPAN_CONTEXT)).toBe(true);
		expect(DETACHED_SPAN_CONTEXT.sampled).toBe(false);
	});

	test('and a real one is not detached', () => {
		expect(
			isDetached({
				traceId: randomTraceId(),
				spanId: randomSpanId(),
				sampled: true,
				remote: false,
			}),
		).toBe(false);
	});
});
