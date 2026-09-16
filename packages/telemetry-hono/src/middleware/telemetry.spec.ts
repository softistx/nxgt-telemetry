import { beforeEach, describe, expect, test } from 'bun:test';
import {
	createLogger,
	createTelemetry,
	type Exporter,
	parseTraceparent,
	type Resource,
	randomSpanId,
	randomTraceId,
	renderTraceparent,
	type Signal,
	type SpanRecord,
} from '@nxgt/telemetry';
import { Hono } from 'hono';
import { telemetry } from './telemetry';

let collected: Signal[] = [];

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

/** A telemetry that ships on every batch, so a spec never waits for a linger. */
function instance() {
	return createTelemetry('checkout', {
		exporters: [collecting()],
		batch: 1,
	});
}

beforeEach(() => {
	collected = [];
});

describe('one span per request', () => {
	test('names it for the route, not for the path it arrived at', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', (c) => c.text('ok'));

		await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(spans()).toHaveLength(1);
		expect(spans()[0]?.name).toBe('GET /orders/:id');
		expect(spans()[0]?.attributes['http.route']).toBe('/orders/:id');
	});

	test('carries the method, the path as it arrived, and the status', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', (c) => c.text('ok'));

		await app.request('http://checkout.example/orders/o-1');
		await tracing.telemetry.close();

		expect(spans()[0]?.attributes).toMatchObject({
			'http.request.method': 'GET',
			'url.path': '/orders/o-1',
			'url.scheme': 'http',
			'server.address': 'checkout.example',
			'http.response.status_code': 200,
		});
	});

	test('is a server span', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/', (c) => c.text('ok'));

		await app.request('/');
		await tracing.telemetry.close();

		expect(spans()[0]?.kind).toBe('server');
	});
});

describe('the status it records', () => {
	/**
	 * The client sent something the server refused, which is the server
	 * working. Counting it as an error is what makes an error rate nobody can
	 * act on.
	 */
	test('a 404 is ok, not an error', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);

		await app.request('/nothing-here');
		await tracing.telemetry.close();

		expect(spans()[0]?.attributes['http.response.status_code']).toBe(404);
		expect(spans()[0]?.status).toBe('ok');
	});

	test('a 400 the handler chose is ok too', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders', (c) => c.text('bad', 400));

		await app.request('/orders');
		await tracing.telemetry.close();

		expect(spans()[0]?.status).toBe('ok');
	});

	test('a 500 marks the span', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders', (c) => c.text('broken', 500));

		await app.request('/orders');
		await tracing.telemetry.close();

		expect(spans()[0]?.status).toBe('error');
	});

	/**
	 * The span observes; it does not handle. Hono's own error handling still
	 * turns the failure into a 500 for the client.
	 */
	test('a handler that throws marks the span and records the failure', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', () => {
			throw new Error('gateway down');
		});

		const reply = await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(reply.status).toBe(500);
		expect(spans()[0]?.status).toBe('error');
		expect(spans()[0]?.error?.type).toBe('Error');
		// Routed before it threw, so the span is still named for the route.
		expect(spans()[0]?.name).toBe('GET /orders/:id');
	});
});

describe('continuing an inbound trace', () => {
	test('a traceparent header joins that trace, as a child of its span', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/', (c) => c.text('ok'));

		const caller = {
			traceId: randomTraceId(),
			spanId: randomSpanId(),
			sampled: true,
			remote: false,
		};

		await app.request('/', {
			headers: { traceparent: renderTraceparent(caller) },
		});
		await tracing.telemetry.close();

		expect(spans()[0]?.context.traceId).toBe(caller.traceId);
		expect(spans()[0]?.parent).toBe(caller.spanId);
		// The span this server opened is its own: local, with a new id.
		expect(spans()[0]?.context.spanId).not.toBe(caller.spanId);
	});

	/** The header came from a stranger; a bad one is not the server's problem. */
	test('an unusable header starts a fresh trace instead of failing', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/', (c) => c.text('ok'));

		const reply = await app.request('/', {
			headers: { traceparent: 'not-a-traceparent' },
		});
		await tracing.telemetry.close();

		expect(reply.status).toBe(200);
		expect(spans()).toHaveLength(1);
		expect(spans()[0]?.parent).toBeUndefined();
	});

	test('no header at all is a root span', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/', (c) => c.text('ok'));

		await app.request('/');
		await tracing.telemetry.close();

		expect(spans()[0]?.parent).toBeUndefined();
		expect(
			parseTraceparent(renderTraceparent(spans()[0]?.context as never)),
		).not.toBeNull();
	});
});

describe('what the handler can reach', () => {
	/**
	 * The span wraps `next()`, so everything the handler awaits is inside its
	 * context. This is the reason it is one middleware and not two hooks.
	 */
	test('a log written in the handler carries the request trace id', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		const log = createLogger('CheckoutService');
		app.use('*', tracing);
		app.get('/orders/:id', async (c) => {
			await Promise.resolve();
			log.info('charged');
			return c.text('ok');
		});

		await app.request('/orders/o-1');
		await tracing.telemetry.close();

		const written = collected.find((one) => one.type === 'log');
		expect(written?.type === 'log' && written.span?.traceId).toBe(
			spans()[0]?.context.traceId,
		);
	});

	test('c.get("span") and c.get("telemetry") are the ones in use', async () => {
		const owned = instance();
		const tracing = telemetry({ instance: owned });
		const app = new Hono();
		let seen: unknown;

		app.use('*', tracing);
		app.get('/', (c) => {
			seen = { span: c.get('span')?.traceId, telemetry: c.get('telemetry') };
			return c.text('ok');
		});

		await app.request('/');
		await tracing.telemetry.close();

		expect(seen).toEqual({
			span: spans()[0]?.context.traceId,
			telemetry: owned,
		});
	});

	test('the handler can add to the span through the scope', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/', (c) => {
			c.get('span')?.attribute('tenant', 'acme');
			c.get('span')?.event('cache.missed');
			return c.text('ok');
		});

		await app.request('/');
		await tracing.telemetry.close();

		expect(spans()[0]?.attributes.tenant).toBe('acme');
		expect(spans()[0]?.events.map((one) => one.name)).toEqual(['cache.missed']);
	});
});

describe('traced', () => {
	test('a request it refuses gets no span, and still answers', async () => {
		const tracing = telemetry({
			instance: instance(),
			traced: (c) => c.req.path !== '/health',
		});
		const app = new Hono();
		app.use('*', tracing);
		app.get('/health', (c) => c.text('ok'));
		app.get('/orders', (c) => c.text('ok'));

		const health = await app.request('/health');
		await app.request('/orders');
		await tracing.telemetry.close();

		expect(health.status).toBe(200);
		expect(spans().map((one) => one.name)).toEqual(['GET /orders']);
	});

	test('a refused request has no span on the context either', async () => {
		const tracing = telemetry({
			instance: instance(),
			traced: () => false,
		});
		const app = new Hono();
		let seen: unknown = 'unset';
		app.use('*', tracing);
		app.get('/health', (c) => {
			seen = c.get('span');
			return c.text('ok');
		});

		await app.request('/health');
		await tracing.telemetry.close();

		expect(seen).toBeUndefined();
	});

	test('nothing is skipped by default', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/health', (c) => c.text('ok'));

		await app.request('/health');
		await tracing.telemetry.close();

		expect(spans()).toHaveLength(1);
	});
});

describe('the names it can be given', () => {
	test('spanName replaces the name it starts with', async () => {
		const tracing = telemetry({
			instance: instance(),
			spanName: (c) => `inbound ${c.req.method}`,
			route: () => undefined,
		});
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', (c) => c.text('ok'));

		await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(spans()[0]?.name).toBe('inbound GET');
	});

	test('route replaces it again, after the handler has run', async () => {
		const tracing = telemetry({
			instance: instance(),
			route: () => '/v2/orders/:id',
		});
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', (c) => c.text('ok'));

		await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(spans()[0]?.name).toBe('GET /v2/orders/:id');
		expect(spans()[0]?.attributes['http.route']).toBe('/v2/orders/:id');
	});

	test('a route hook that throws leaves the name it had', async () => {
		const tracing = telemetry({
			instance: instance(),
			route: () => {
				throw new Error('no');
			},
		});
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', (c) => c.text('ok'));

		const reply = await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(reply.status).toBe(200);
		expect(spans()[0]?.name).toBe('GET /orders/o-1');
		expect(spans()[0]?.attributes['http.route']).toBeUndefined();
	});

	/** A request that matched nothing has no route to report. */
	test('an unmatched request keeps the path in its name', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);

		await app.request('/nothing-here');
		await tracing.telemetry.close();

		expect(spans()[0]?.name).toBe('GET /nothing-here');
		expect(spans()[0]?.attributes['http.route']).toBeUndefined();
	});
});

describe('the telemetry it uses', () => {
	test('builds and installs one from a service name', async () => {
		const tracing = telemetry({
			service: 'checkout',
			version: '1.4.0',
			exporters: [collecting()],
			batch: 1,
		});
		const app = new Hono();
		app.use('*', tracing);
		app.get('/', (c) => c.text('ok'));

		await app.request('/');
		await tracing.telemetry.close();

		expect(tracing.telemetry.resource).toMatchObject({
			service: 'checkout',
			version: '1.4.0',
		});
		expect(spans()).toHaveLength(1);
	});

	/** It is adopted, not owned: closing it is the application's decision. */
	test('an instance it was handed is the one it exposes, and it is not closed', async () => {
		const owned = instance();
		const tracing = telemetry({ instance: owned });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/', (c) => c.text('ok'));

		await app.request('/');
		expect(tracing.telemetry).toBe(owned);

		// Still open: a second request is still recorded.
		await app.request('/');
		await owned.close();
		expect(spans()).toHaveLength(2);
	});
});
