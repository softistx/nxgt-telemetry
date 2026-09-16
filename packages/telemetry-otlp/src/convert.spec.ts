import { describe, expect, test } from 'bun:test';
import type {
	LogRecord,
	Resource,
	SpanContext,
	SpanId,
	SpanRecord,
	TraceId,
} from '@nxgt/telemetry';
import {
	anyValue,
	keyValues,
	logsRequest,
	nanos,
	otlpResource,
	SPAN_SCOPE,
	STATUS_CODE,
	tracesRequest,
} from './convert';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736' as TraceId;
const SPAN = '00f067aa0ba902b7' as SpanId;
const PARENT = '00f067aa0ba902b8' as SpanId;

const CONTEXT: SpanContext = {
	traceId: TRACE,
	spanId: SPAN,
	sampled: true,
	remote: false,
};

const RESOURCE: Resource = {
	service: 'checkout',
	version: '1.4.0',
	environment: 'production',
	attributes: { 'host.name': 'pod-7' },
};

const AT = Date.UTC(2026, 8, 15, 10, 4, 22, 318);

function log(overrides: Partial<LogRecord> = {}): LogRecord {
	return {
		type: 'log',
		at: AT,
		severity: 'info',
		name: 'checkout.charged',
		source: 'CheckoutService',
		attributes: { orderId: 'o-1' },
		...overrides,
	};
}

function span(overrides: Partial<SpanRecord> = {}): SpanRecord {
	return {
		type: 'span',
		name: 'charge',
		context: CONTEXT,
		kind: 'client',
		startedAt: AT,
		endedAt: AT + 84,
		status: 'ok',
		attributes: {},
		events: [],
		...overrides,
	};
}

describe('nanos', () => {
	/**
	 * `Date.now() * 1e6` passed `Number.MAX_SAFE_INTEGER` in 2001, so a `number`
	 * would round the last digits and two signals a microsecond apart would
	 * arrive with the same timestamp. The field is text on the wire for the
	 * same reason.
	 */
	test('is exact past the safe integer, which a number is not', () => {
		expect(nanos(AT)).toBe('1789466662318000000');

		// What the arithmetic this avoids actually does: the float cannot
		// count the last nanosecond, so it answers the same instant twice.
		expect(Number.isSafeInteger(AT * 1_000_000)).toBe(false);
		expect(AT * 1_000_000 + 1).toBe(AT * 1_000_000);
	});

	test('is a decimal string, never a number', () => {
		expect(typeof nanos(AT)).toBe('string');
		expect(nanos(0)).toBe('0');
	});
});

describe('anyValue', () => {
	test('tags a string, a boolean and a double', () => {
		expect(anyValue('o-1')).toEqual({ stringValue: 'o-1' });
		expect(anyValue(true)).toEqual({ boolValue: true });
		expect(anyValue(4.5)).toEqual({ doubleValue: 4.5 });
	});

	/**
	 * A whole number is an integer to every backend that groups by it, and it
	 * crosses as text so the low bits survive.
	 */
	test('a whole number is an intValue, as a string', () => {
		expect(anyValue(4200)).toEqual({ intValue: '4200' });
		expect(anyValue(-1)).toEqual({ intValue: '-1' });
	});

	test('null is the unset value, not the text "null"', () => {
		expect(anyValue(null)).toEqual({});
	});

	test('a list is an arrayValue of tagged values', () => {
		expect(anyValue(['a', 1, true])).toEqual({
			arrayValue: {
				values: [{ stringValue: 'a' }, { intValue: '1' }, { boolValue: true }],
			},
		});
	});
});

describe('otlpResource', () => {
	test('carries the three keys every backend looks for', () => {
		expect(otlpResource(RESOURCE).attributes).toEqual([
			{ key: 'service.name', value: { stringValue: 'checkout' } },
			{ key: 'service.version', value: { stringValue: '1.4.0' } },
			{
				key: 'deployment.environment.name',
				value: { stringValue: 'production' },
			},
			{ key: 'host.name', value: { stringValue: 'pod-7' } },
		]);
	});

	test('omits a version and an environment that were never given', () => {
		const bare = otlpResource({ service: 'checkout', attributes: {} });
		expect(bare.attributes).toEqual([
			{ key: 'service.name', value: { stringValue: 'checkout' } },
		]);
	});

	test('an attribute that names one of the three wins: it was set on purpose', () => {
		const overridden = otlpResource({
			service: 'checkout',
			attributes: { 'service.name': 'checkout-worker' },
		});
		expect(overridden.attributes).toEqual([
			{ key: 'service.name', value: { stringValue: 'checkout-worker' } },
		]);
	});
});

describe('logsRequest', () => {
	test('is the reference document for one log', () => {
		expect(logsRequest(RESOURCE, [log({ span: CONTEXT })])).toEqual({
			resourceLogs: [
				{
					resource: otlpResource(RESOURCE),
					scopeLogs: [
						{
							scope: { name: 'CheckoutService' },
							logRecords: [
								{
									timeUnixNano: '1789466662318000000',
									observedTimeUnixNano: '1789466662318000000',
									severityNumber: 9,
									severityText: 'INFO',
									body: { stringValue: 'checkout.charged' },
									attributes: [
										{ key: 'orderId', value: { stringValue: 'o-1' } },
									],
									traceId: TRACE,
									spanId: SPAN,
									flags: 1,
								},
							],
						},
					],
				},
			],
		});
	});

	/**
	 * The logger's name is the instrumentation scope, which is what lets a
	 * backend filter by the component that wrote the line rather than by the
	 * service that ran it.
	 */
	test('groups by source, one scope each, in the order they first appear', () => {
		const request = logsRequest(RESOURCE, [
			log({ source: 'CheckoutService', name: 'a' }),
			log({ source: 'PaymentGateway', name: 'b' }),
			log({ source: 'CheckoutService', name: 'c' }),
		]);

		const scopes = request?.resourceLogs[0]?.scopeLogs ?? [];
		expect(scopes.map((scope) => scope.scope.name)).toEqual([
			'CheckoutService',
			'PaymentGateway',
		]);
		expect(scopes[0]?.logRecords).toHaveLength(2);
		expect(scopes[1]?.logRecords).toHaveLength(1);
	});

	test('a log written outside a span carries no ids at all', () => {
		const record = logsRequest(RESOURCE, [log()])?.resourceLogs[0]?.scopeLogs[0]
			?.logRecords[0];

		expect(record).not.toHaveProperty('traceId');
		expect(record).not.toHaveProperty('spanId');
		expect(record).not.toHaveProperty('flags');
	});

	/**
	 * A log is never sampled, so one from an unsampled trace still arrives —
	 * carrying the flag that says the span it belongs to will not.
	 */
	test('a log of an unsampled trace carries its ids, with flags 0', () => {
		const record = logsRequest(RESOURCE, [
			log({ span: { ...CONTEXT, sampled: false } }),
		])?.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];

		expect(record?.traceId).toBe(TRACE);
		expect(record?.flags).toBe(0);
	});

	test('a failure travels as attributes, under the convention keys', () => {
		const record = logsRequest(RESOURCE, [
			log({
				error: {
					type: 'ChargeRefused',
					message: 'card expired',
					stackTrace: 'at charge',
				},
			}),
		])?.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];

		expect(record?.attributes).toEqual([
			{ key: 'orderId', value: { stringValue: 'o-1' } },
			{ key: 'exception.type', value: { stringValue: 'ChargeRefused' } },
			{ key: 'exception.message', value: { stringValue: 'card expired' } },
			{ key: 'exception.stacktrace', value: { stringValue: 'at charge' } },
		]);
	});

	test('a batch of spans alone produces no document to send', () => {
		expect(logsRequest(RESOURCE, [span()])).toBeUndefined();
		expect(logsRequest(RESOURCE, [])).toBeUndefined();
	});
});

describe('tracesRequest', () => {
	test('is the reference document for one span', () => {
		expect(
			tracesRequest(RESOURCE, [
				span({
					parent: PARENT,
					attributes: { 'http.route': '/orders/:id' },
					events: [{ name: 'retry', at: AT + 10, attributes: { attempt: 2 } }],
				}),
			]),
		).toEqual({
			resourceSpans: [
				{
					resource: otlpResource(RESOURCE),
					scopeSpans: [
						{
							scope: { name: SPAN_SCOPE },
							spans: [
								{
									traceId: TRACE,
									spanId: SPAN,
									parentSpanId: PARENT,
									name: 'charge',
									kind: 3,
									startTimeUnixNano: '1789466662318000000',
									endTimeUnixNano: '1789466662402000000',
									attributes: [
										{
											key: 'http.route',
											value: { stringValue: '/orders/:id' },
										},
									],
									events: [
										{
											timeUnixNano: '1789466662328000000',
											name: 'retry',
											attributes: [
												{ key: 'attempt', value: { intValue: '2' } },
											],
										},
									],
									status: { code: 1 },
								},
							],
						},
					],
				},
			],
		});
	});

	test('a root span carries no parentSpanId, rather than a zero one', () => {
		const emitted = tracesRequest(RESOURCE, [span()])?.resourceSpans[0]
			?.scopeSpans[0]?.spans[0];
		expect(emitted).not.toHaveProperty('parentSpanId');
	});

	/**
	 * `cancelled` is unset, not error: a shutdown and a timeout are not
	 * failures, and OTLP has no third code, so the honest answer is to say
	 * nothing rather than to say "failed".
	 */
	test('cancelled is unset, not error', () => {
		expect(STATUS_CODE).toEqual({ ok: 1, error: 2, cancelled: 0 });
	});

	test('a failed span carries the message on the status and the type as an attribute', () => {
		const emitted = tracesRequest(RESOURCE, [
			span({
				status: 'error',
				error: { type: 'ChargeRefused', message: 'card expired' },
			}),
		])?.resourceSpans[0]?.scopeSpans[0]?.spans[0];

		expect(emitted?.status).toEqual({ code: 2, message: 'card expired' });
		expect(emitted?.attributes).toContainEqual({
			key: 'exception.type',
			value: { stringValue: 'ChargeRefused' },
		});
	});

	test('a batch of logs alone produces no document to send', () => {
		expect(tracesRequest(RESOURCE, [log()])).toBeUndefined();
		expect(tracesRequest(RESOURCE, [])).toBeUndefined();
	});
});

describe('keyValues', () => {
	test('keeps the order the attributes were written in', () => {
		expect(keyValues({ b: 1, a: 2 }).map((pair) => pair.key)).toEqual([
			'b',
			'a',
		]);
	});
});
