import { describe, expect, test } from 'bun:test';
import { randomSpanId, randomTraceId, type SpanContext } from '../trace/ids';
import {
	meetsSeverity,
	SEVERITIES,
	SEVERITY_NUMBER,
	type Signal,
	SPAN_KIND_NUMBER,
	signalAt,
	signalSpan,
} from './signal';

/**
 * The numbers here are OTLP's, and they are shared with `stx-telemetry`. A
 * change to one of them is a divergence between the two estates, not a detail,
 * which is why they are asserted literally.
 */
describe('the vocabulary', () => {
	test('four severities, numbered as OTLP numbers them', () => {
		expect(SEVERITY_NUMBER).toEqual({ debug: 5, info: 9, warn: 13, error: 17 });
		expect(SEVERITIES).toEqual(['debug', 'info', 'warn', 'error']);
	});

	test('there is no trace level', () => {
		expect(Object.keys(SEVERITY_NUMBER)).not.toContain('trace');
	});

	test('five span kinds, numbered as OTLP numbers them', () => {
		expect(SPAN_KIND_NUMBER).toEqual({
			internal: 1,
			server: 2,
			client: 3,
			producer: 4,
			consumer: 5,
		});
	});

	test('a floor admits itself and everything above it', () => {
		expect(meetsSeverity('info', 'info')).toBe(true);
		expect(meetsSeverity('error', 'info')).toBe(true);
		expect(meetsSeverity('debug', 'info')).toBe(false);
	});
});

describe('reading either kind of signal', () => {
	const context: SpanContext = {
		traceId: randomTraceId(),
		spanId: randomSpanId(),
		sampled: true,
		remote: false,
	};

	const log: Signal = {
		type: 'log',
		at: 1_000,
		severity: 'info',
		name: 'checkout.charged',
		source: 'CheckoutService',
		attributes: {},
		span: context,
	};

	const span: Signal = {
		type: 'span',
		name: 'charge',
		context,
		kind: 'internal',
		startedAt: 2_000,
		endedAt: 2_500,
		status: 'ok',
		attributes: {},
		events: [],
	};

	test('a span is read at the moment it started', () => {
		expect(signalAt(log)).toBe(1_000);
		expect(signalAt(span)).toBe(2_000);
	});

	test('a span is always its own span', () => {
		expect(signalSpan(log)).toBe(context);
		expect(signalSpan(span)).toBe(context);
	});

	test('a log outside any span has none', () => {
		expect(signalSpan({ ...log, span: undefined })).toBeUndefined();
	});
});
