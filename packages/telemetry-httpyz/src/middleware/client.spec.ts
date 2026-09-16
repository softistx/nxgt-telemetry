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

	/**
	 * `retry` and `auth` sit **outside** the middlewares in `@nxgt/httpyz`, so a
	 * retried call re-enters the chain and opens a fresh span. Three attempts
	 * are three spans under one parent, which is what a trace should show — and
	 * a middleware cannot see that it is the second one.
	 */
	test('a retried call is a span per attempt, not one span', async () => {
		const telemetry = createTelemetry('checkout', {
			exporters: [collecting()],
			batch: 1,
		});
		let attempt = 0;
		const api = createHttpClient({
			baseUrl,
			retry: 2,
			use: [tracing()],
			fetch: async () =>
				++attempt < 3
					? new Response('', { status: 503 })
					: new Response('{}', {
							headers: { 'content-type': 'application/json' },
						}),
		});

		await withTelemetry(telemetry, () =>
			span('GET /orders/:id', { kind: 'server' }, async () => {
				await api.get('/employees/{id}', { param: { id: 'e-1' } });
			}),
		);
		await telemetry.close();

		const clients = spans().filter((one) => one.kind === 'client');
		expect(attempt).toBe(3);
		expect(clients.map((one) => one.status)).toEqual(['error', 'error', 'ok']);

		// All three under the one server span, so the trace reads as one call
		// that took three tries.
		const server_ = spans().find((one) => one.kind === 'server');
		for (const client of clients) {
			expect(client.parent).toBe(server_?.context.spanId);
		}
		expect(new Set(clients.map((one) => one.context.spanId)).size).toBe(3);
	});

	/**
	 * Two calls in flight across an `await` must not see each other's span —
	 * and each outgoing header must carry its own.
	 */
	test('concurrent calls each carry their own span', async () => {
		const telemetry = createTelemetry('checkout', {
			exporters: [collecting()],
			batch: 1,
		});
		const api = createHttpClient({ baseUrl, use: [tracing()] });

		await withTelemetry(telemetry, () =>
			span('GET /orders/:id', { kind: 'server' }, async () => {
				await Promise.all(
					['a', 'b', 'c'].map((id) =>
						api.get('/employees/{id}', { param: { id } }),
					),
				);
			}),
		);
		await telemetry.close();

		const clients = spans().filter((one) => one.kind === 'client');
		const server_ = spans().find((one) => one.kind === 'server');

		expect(clients).toHaveLength(3);
		expect(new Set(clients.map((one) => one.context.spanId)).size).toBe(3);
		expect(new Set(received).size).toBe(3);
		for (const client of clients) {
			expect(client.parent).toBe(server_?.context.spanId);
		}
	});

	/** A call released after the span that made it still belongs to it. */
	test('a call that outlives its span is still parented to it', async () => {
		const telemetry = createTelemetry('checkout', {
			exporters: [collecting()],
			batch: 1,
		});
		const api = createHttpClient({ baseUrl, use: [tracing()] });
		let pending: Promise<unknown> | undefined;

		await withTelemetry(telemetry, async () => {
			await span('GET /orders/:id', { kind: 'server' }, async () => {
				pending = api.get('/employees/{id}', { param: { id: 'e-1' } });
			});
			await pending;
		});
		await telemetry.close();

		const server_ = spans().find((one) => one.kind === 'server');
		const client = spans().find((one) => one.kind === 'client');

		expect(client?.parent).toBe(server_?.context.spanId);
		expect(client?.context.traceId).toBe(server_?.context.traceId);
	});

	test('a client with no telemetry around it still calls', async () => {
		const api = createHttpClient({ baseUrl, use: [tracing()] });
		const reply = await api.get('/employees/{id}', { param: { id: 'e-1' } });

		expect(reply.status).toBe(200);
		expect(received[0]).toBeNull();
		expect(collected).toHaveLength(0);
	});
});
