/**
 * The exporter against a real HTTP server, rather than a `fetch` double.
 *
 * `otlp.spec.ts` decides what the exporter does; this decides that the bytes
 * it actually puts on a socket are the bytes a collector reads — the gzip
 * header, the JSON body, the two paths. A hand-written wire format has to be
 * checked over a wire at least once.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import {
	createTelemetry,
	type LogRecord,
	type Resource,
	span,
	withTelemetry,
} from '@nxgt/telemetry';
import type {
	ExportLogsServiceRequest,
	ExportTraceServiceRequest,
} from '../wire/documents';
import { otlpExporter } from './otlp';

const RESOURCE: Resource = {
	service: 'checkout',
	version: '1.4.0',
	attributes: {},
};

interface Received {
	readonly path: string;
	readonly gzipped: boolean;
	readonly document: unknown;
}

let server: ReturnType<typeof Bun.serve>;
let endpoint: string;
let received: Received[] = [];
let answer: () => Response = () => new Response('{}');

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(request) {
			const gzipped = request.headers.get('content-encoding') === 'gzip';
			const bytes = new Uint8Array(await request.arrayBuffer());
			const text = new TextDecoder().decode(
				gzipped ? gunzipSync(bytes) : bytes,
			);

			received.push({
				path: new URL(request.url).pathname,
				gzipped,
				document: JSON.parse(text),
			});

			return answer();
		},
	});
	endpoint = `http://localhost:${server.port}`;
});

afterAll(() => {
	server.stop(true);
});

function reset(): void {
	received = [];
	answer = () => new Response('{}');
}

function log(name: string): LogRecord {
	return {
		type: 'log',
		at: Date.UTC(2026, 8, 15, 10, 4, 22),
		severity: 'info',
		name,
		source: 'CheckoutService',
		attributes: { orderId: 'o-1' },
	};
}

describe('against a server that speaks HTTP', () => {
	test('a log arrives as a readable OTLP document', async () => {
		reset();
		await otlpExporter({ endpoint }).export(RESOURCE, [log('charged')]);

		expect(received).toHaveLength(1);
		expect(received[0]?.path).toBe('/v1/logs');

		const document = received[0]?.document as ExportLogsServiceRequest;
		const record = document.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
		expect(record?.body).toEqual({ stringValue: 'charged' });
		expect(record?.timeUnixNano).toBe('1789466662000000000');
		expect(document.resourceLogs[0]?.resource.attributes).toContainEqual({
			key: 'service.name',
			value: { stringValue: 'checkout' },
		});
	});

	test('a gzipped document decompresses to the same thing', async () => {
		reset();
		const many = Array.from({ length: 200 }, (_unused, index) =>
			log(`charged-${index}`),
		);
		await otlpExporter({ endpoint }).export(RESOURCE, many);

		expect(received[0]?.gzipped).toBe(true);
		const document = received[0]?.document as ExportLogsServiceRequest;
		expect(document.resourceLogs[0]?.scopeLogs[0]?.logRecords).toHaveLength(
			200,
		);
	});

	/**
	 * The whole path, from the application's `span()` through the pipeline to
	 * the collector: this is the only place that proves the trace identity
	 * survives all three.
	 */
	test('a real span reaches the collector, with its trace identity intact', async () => {
		reset();
		const telemetry = createTelemetry('checkout', {
			exporters: [otlpExporter({ endpoint })],
			linger: 10,
		});

		const traceparent = await withTelemetry(telemetry, () =>
			span('charge', async (scope) => {
				scope.attribute('http.route', '/orders/:id');
				return scope.traceparent();
			}),
		);
		await telemetry.close();

		const traces = received.find((call) => call.path === '/v1/traces');
		const document = traces?.document as ExportTraceServiceRequest;
		const emitted = document.resourceSpans[0]?.scopeSpans[0]?.spans[0];

		expect(emitted?.name).toBe('charge');
		expect(traceparent).toContain(emitted?.traceId as string);
		expect(traceparent).toContain(emitted?.spanId as string);
		expect(emitted?.attributes).toContainEqual({
			key: 'http.route',
			value: { stringValue: '/orders/:id' },
		});
	});

	test('a collector that refuses is reported, not swallowed', async () => {
		reset();
		answer = () => new Response('nope', { status: 400 });

		const failure = await otlpExporter({ endpoint })
			.export(RESOURCE, [log('charged')])
			?.catch((thrown: unknown) => thrown);

		expect((failure as Error).message).toContain('rejected logs with 400');
	});
});
