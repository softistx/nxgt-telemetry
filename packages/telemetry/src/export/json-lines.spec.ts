import { describe, expect, test } from 'bun:test';
import type { LogRecord, Resource, Signal, SpanRecord } from '../model/signal';
import type { SpanContext } from '../trace/ids';
import { jsonLinesExporter } from './json-lines';

const RESOURCE: Resource = { service: 'checkout', attributes: {} };

const SPAN: SpanContext = {
	traceId: '4bf92f3577b34da6a3ce929d0e0e4736' as SpanContext['traceId'],
	spanId: '00f067aa0ba902b7' as SpanContext['spanId'],
	sampled: true,
	remote: false,
};

const log: LogRecord = {
	type: 'log',
	at: 1_757_930_662_318,
	severity: 'info',
	name: 'checkout.charged',
	source: 'CheckoutService',
	attributes: { orderId: 'o-1' },
	span: SPAN,
};

const span: SpanRecord = {
	type: 'span',
	name: 'charge',
	context: SPAN,
	kind: 'internal',
	startedAt: 1_757_930_662_318,
	endedAt: 1_757_930_662_402,
	status: 'ok',
	attributes: {},
	events: [],
};

function lines(batch: readonly Signal[]): string[] {
	const written: string[] = [];
	jsonLinesExporter({ write: (line) => written.push(line) }).export(
		RESOURCE,
		batch,
	);
	return written;
}

describe('a line', () => {
	test('is the signal, discriminated on `type`', () => {
		const [logLine, spanLine] = lines([log, span]);

		expect(JSON.parse(logLine as string)).toEqual({
			type: 'log',
			at: 1_757_930_662_318,
			severity: 'info',
			name: 'checkout.charged',
			source: 'CheckoutService',
			attributes: { orderId: 'o-1' },
			span: SPAN,
		});
		expect(JSON.parse(spanLine as string).type).toBe('span');
	});

	test('is one line per signal, with no newline inside it', () => {
		expect(lines([log, span])).toHaveLength(2);
		expect(lines([log])[0]).not.toContain('\n');
	});

	test('does not carry the resource: a file belongs to one service', () => {
		expect(lines([log])[0]).not.toContain('checkout"');
		expect(JSON.parse(lines([log])[0] as string).service).toBeUndefined();
	});

	test('leaves out what is absent rather than writing null', () => {
		const parsed = JSON.parse(
			lines([{ ...log, span: undefined }])[0] as string,
		);
		expect('span' in parsed).toBe(false);
	});
});

describe('a signal that will not serialise', () => {
	test('is skipped without costing the rest of the batch', () => {
		const circular = { type: 'log', at: 0 } as unknown as Record<
			string,
			unknown
		>;
		circular.self = circular;

		const written = lines([circular as unknown as Signal, log]);

		expect(written).toHaveLength(1);
		expect(JSON.parse(written[0] as string).name).toBe('checkout.charged');
	});
});
