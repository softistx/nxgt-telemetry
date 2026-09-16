import { describe, expect, test } from 'bun:test';
import type { LogRecord, Resource, SpanRecord } from '../model/signal';
import type { SpanContext } from '../trace/ids';
import { consoleExporter } from './console';

const RESOURCE: Resource = { service: 'checkout', attributes: {} };

const SPAN: SpanContext = {
	traceId: '4bf92f3577b34da6a3ce929d0e0e4736' as SpanContext['traceId'],
	spanId: '00f067aa0ba902b7' as SpanContext['spanId'],
	sampled: true,
	remote: false,
};

const AT = Date.UTC(2026, 8, 15, 10, 4, 22, 318);

function lines(signals: (LogRecord | SpanRecord)[], stackTraces = true) {
	const written: string[] = [];
	consoleExporter({ write: (line) => written.push(line), stackTraces }).export(
		RESOURCE,
		signals,
	);
	return written;
}

const log: LogRecord = {
	type: 'log',
	at: AT,
	severity: 'info',
	name: 'checkout.charged',
	source: 'CheckoutService',
	attributes: { orderId: 'o-1', amount: 4200 },
	span: SPAN,
};

const span: SpanRecord = {
	type: 'span',
	name: 'charge',
	context: SPAN,
	kind: 'internal',
	startedAt: AT,
	endedAt: AT + 84,
	status: 'ok',
	attributes: {},
	events: [],
};

describe('a log line', () => {
	test('is the clock, the level, the source, the name, the attributes and the trace', () => {
		expect(lines([log])).toEqual([
			'10:04:22.318  INFO   CheckoutService  checkout.charged  orderId=o-1 amount=4200  [4bf92f35/00f067aa]',
		]);
	});

	test('written outside a span carries no trace', () => {
		expect(lines([{ ...log, span: undefined }])[0]).not.toContain('[');
	});

	test('with no attributes says nothing about them', () => {
		expect(lines([{ ...log, attributes: {} }])[0]).toContain(
			'checkout.charged  [4bf92f35',
		);
	});

	test('renders a list of scalars', () => {
		expect(
			lines([{ ...log, attributes: { scopes: ['read', 'write'] } }])[0],
		).toContain('scopes=[read,write]');
	});

	test('carries the failure, and its stack under it', () => {
		expect(
			lines([
				{
					...log,
					severity: 'error',
					error: {
						type: 'ChargeRefused',
						message: 'no funds',
						stackTrace: 'at …',
					},
				},
			]),
		).toEqual([
			'10:04:22.318  ERROR  CheckoutService  checkout.charged  orderId=o-1 amount=4200  ChargeRefused: no funds  [4bf92f35/00f067aa]',
			'at …',
		]);
	});

	test('and the stack can be turned off', () => {
		expect(
			lines(
				[{ ...log, error: { type: 'ChargeRefused', stackTrace: 'at …' } }],
				false,
			),
		).toHaveLength(1);
	});
});

describe('a span line', () => {
	test('is the clock it ended at, its name and how long it took', () => {
		expect(lines([span])).toEqual([
			'10:04:22.402  SPAN   charge  84ms  [4bf92f35/00f067aa]',
		]);
	});

	test('says its status only when it is not ok', () => {
		expect(lines([{ ...span, status: 'error' }])[0]).toContain('ERROR');
		expect(lines([{ ...span, status: 'cancelled' }])[0]).toContain('CANCELLED');
		expect(lines([span])[0]).not.toContain('OK');
	});
});
