/**
 * The middleware inside a real `@nxgt/httpyz` client, against a real server.
 *
 * `tracing.spec.ts` decides what the middleware does with a `next` it was
 * handed. This decides that it composes with the client that will actually call
 * it, and that the header reaches the other end of a socket.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { createHttpClient } from '@nxgt/httpyz';
import {
	createTelemetry,
	type Exporter,
	parseTraceparent,
	type Resource,
	type Signal,
	type SpanRecord,
	span,
	withTelemetry,
} from '@nxgt/telemetry';
import { TRACEPARENT, tracing } from './tracing';

let collected: Signal[] = [];
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let received: (string | null)[] = [];

function collecting(): Exporter {
	return {
		export(_resource: Resource, batch: readonly Signal[]): void {
			collected.push(...batch);
		},
	};
}

function spans(): SpanRecord[] {
	return collected.filter((one): one is SpanRecord => one.type === 'span');
}

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(request) {
			received.push(request.headers.get(TRACEPARENT));
			const path = new URL(request.url).pathname;

			return path === '/employees/missing'
				? new Response('{}', { status: 404 })
				: new Response(JSON.stringify({ id: 'e-1' }), {
						headers: { 'content-type': 'application/json' },
					});
		},
	});
	baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => {
	collected = [];
	received = [];
});

describe('inside a real client', () => {
	test('the traceparent arrives at the other end of the socket', async () => {
		const telemetry = createTelemetry('checkout', {
			exporters: [collecting()],
			batch: 1,
		});
		const api = createHttpClient({ baseUrl, use: [tracing()] });

		await withTelemetry(telemetry, () =>
			span('GET /orders/:id', { kind: 'server' }, async () => {
				await api.get('/employees/{id}', { param: { id: 'e-1' } });
			}),
		);
		await telemetry.close();

		const server_ = spans().find((one) => one.kind === 'server');
		const client = spans().find((one) => one.kind === 'client');
		const parsed = parseTraceparent(received[0]);

		expect(received).toHaveLength(1);
		expect(parsed?.traceId).toBe(server_?.context.traceId);
		expect(parsed?.spanId).toBe(client?.context.spanId);
		expect(client?.parent).toBe(server_?.context.spanId);
	});

	test('the span is named for the template the caller wrote', async () => {
		const telemetry = createTelemetry('checkout', {
			exporters: [collecting()],
			batch: 1,
		});
		const api = createHttpClient({ baseUrl, use: [tracing()] });

		await withTelemetry(telemetry, () =>
			api.get('/employees/{id}', { param: { id: 'e-1' } }),
		);
		await telemetry.close();

		expect(spans()[0]?.name).toBe('GET /employees/{id}');
		expect(spans()[0]?.attributes['url.full']).toBe(`${baseUrl}/employees/e-1`);
	});

	test('a 404 the caller asked for is an error on the client span', async () => {
		const telemetry = createTelemetry('checkout', {
			exporters: [collecting()],
			batch: 1,
		});
		const api = createHttpClient({ baseUrl, use: [tracing()] });

		await withTelemetry(telemetry, () =>
			api.get('/employees/{id}', { param: { id: 'missing' } }),
		);
		await telemetry.close();

		expect(spans()[0]?.status).toBe('error');
		expect(spans()[0]?.attributes['http.response.status_code']).toBe(404);
	});

	test('a client with no telemetry around it still calls', async () => {
		const api = createHttpClient({ baseUrl, use: [tracing()] });
		const reply = await api.get('/employees/{id}', { param: { id: 'e-1' } });

		expect(reply.status).toBe(200);
		expect(received[0]).toBeNull();
		expect(collected).toHaveLength(0);
	});
});
