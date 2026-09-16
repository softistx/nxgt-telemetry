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

	/**
	 * The one query anybody actually writes is "everything in this trace", and
	 * the trace id lives at two different paths — `span.traceId` on a log,
	 * `context.traceId` on a span. Lifted, it is one field and one index.
	 */
	test('lifts traceId and spanId to the top level, from either kind', () => {
		expect(documentOf(RESOURCE, SPAN)).toMatchObject({
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
		});

		expect(documentOf(RESOURCE, { ...LOG, span: SPAN.context })).toMatchObject({
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
		});
	});

	test('a log written outside any span carries no traceId', () => {
		const document = documentOf(RESOURCE, LOG);

		expect(document).not.toHaveProperty('traceId');
		expect(document).not.toHaveProperty('spanId');
	});

	/**
	 * `@nxgt/telemetry-otlp` puts them on every export, and a service that
	 * swaps one exporter for the other must not lose `deployment.region` with
	 * no error and no note.
	 */
	test("stamps the resource's attributes, under `resource`", () => {
		const document = documentOf(
			{ ...RESOURCE, attributes: { 'deployment.region': 'eu-west-1' } },
			LOG,
		);

		expect(document.resource).toEqual({ 'deployment.region': 'eu-west-1' });
	});

	test('omits `resource` when there are no resource attributes', () => {
		expect(documentOf(RESOURCE, LOG)).not.toHaveProperty('resource');
	});

	/**
	 * Which is why they are a sub-document rather than flattened beside
	 * `service`: a resource attribute is named by whoever configured the
	 * service, and one called `name` flattened here would overwrite the
	 * signal's own.
	 */
	test('a resource attribute cannot overwrite a field of the signal', () => {
		const document = documentOf(
			{ ...RESOURCE, attributes: { name: 'not the log name', type: 'span' } },
			LOG,
		);

		expect(document.name).toBe('checkout.charged');
		expect(document.type).toBe('log');
		expect(document.resource).toEqual({
			name: 'not the log name',
			type: 'span',
		});
	});
});
