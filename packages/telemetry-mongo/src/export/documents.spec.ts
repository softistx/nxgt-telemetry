import { describe, expect, test } from 'bun:test';
import type { LogRecord, Resource, SpanRecord } from '@nxgt/telemetry';
import { documentOf } from './documents';

const RESOURCE: Resource = {
	service: 'checkout',
	version: '1.4.0',
	environment: 'production',
	attributes: {},
};

const AT = Date.UTC(2026, 8, 15, 10, 4, 22, 318);

const LOG: LogRecord = {
	type: 'log',
	at: AT,
	severity: 'info',
	name: 'checkout.charged',
	source: 'CheckoutService',
	attributes: { orderId: 'o-1' },
};

const SPAN: SpanRecord = {
	type: 'span',
	name: 'charge',
	context: {
		traceId: '4bf92f3577b34da6a3ce929d0e0e4736' as never,
		spanId: '00f067aa0ba902b7' as never,
		sampled: true,
		remote: false,
	},
	kind: 'client',
	startedAt: AT,
	endedAt: AT + 84,
	status: 'ok',
	attributes: {},
	events: [{ name: 'retry', at: AT + 10, attributes: { attempt: 2 } }],
};

describe('documentOf', () => {
	/**
	 * Stored as an epoch number, an instant is neither a range a query can use
	 * nor something a TTL index can expire.
	 */
	test('every instant becomes a BSON Date', () => {
		const document = documentOf(RESOURCE, SPAN);

		expect(document.at).toBeInstanceOf(Date);
		expect(document.startedAt).toBeInstanceOf(Date);
		expect(document.endedAt).toBeInstanceOf(Date);
		expect((document.events as { at: Date }[])[0]?.at).toBeInstanceOf(Date);
		expect((document.at as Date).getTime()).toBe(AT);
	});

	/**
	 * A collection here is shared by every service that writes to it, which is
	 * the opposite of a log file.
	 */
	test('stamps the resource on every document', () => {
		expect(documentOf(RESOURCE, LOG)).toMatchObject({
			service: 'checkout',
			version: '1.4.0',
			environment: 'production',
		});
	});

	test('omits a version and an environment that were never given', () => {
		const bare = documentOf({ service: 'checkout', attributes: {} }, LOG);

		expect(bare.service).toBe('checkout');
		expect(bare).not.toHaveProperty('version');
		expect(bare).not.toHaveProperty('environment');
	});

	/**
	 * A span is stamped with its start, so one index answers "what happened in
	 * this minute" for logs and spans alike, and one TTL index expires both.
	 */
	test('a span carries `at`, which is its start', () => {
		expect((documentOf(RESOURCE, SPAN).at as Date).getTime()).toBe(AT);
		expect((documentOf(RESOURCE, LOG).at as Date).getTime()).toBe(AT);
	});

	test('changes nothing else about the signal', () => {
		const document = documentOf(RESOURCE, LOG);

		expect(document.type).toBe('log');
		expect(document.severity).toBe('info');
		expect(document.name).toBe('checkout.charged');
		expect(document.source).toBe('CheckoutService');
		expect(document.attributes).toEqual({ orderId: 'o-1' });
	});

	test('a resource key never replaces one the signal already had', () => {
		// `service` is stamped; `name` belongs to the signal and stays its own.
		expect(documentOf(RESOURCE, LOG).name).toBe('checkout.charged');
	});
});
