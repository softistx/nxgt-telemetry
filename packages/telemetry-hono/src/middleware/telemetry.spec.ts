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
import { HTTPException } from 'hono/http-exception';
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

describe('a failure the framework caught', () => {
	/**
	 * `HTTPException` is how a Hono application says `401`: it is what
	 * `basicAuth`, `bearerAuth`, `jwt` and the validators all throw. Letting a
	 * thrown failure mark the span would put every rejected login in the error
	 * rate — which is the outcome the 4xx rule exists to prevent.
	 */
	test('a thrown 4xx is ok, and still carries what was thrown', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', () => {
			throw new HTTPException(401, { message: 'no token' });
		});

		const reply = await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(reply.status).toBe(401);
		expect(spans()[0]?.status).toBe('ok');
		expect(spans()[0]?.error?.type).toBe('HTTPException');
		expect(spans()[0]?.attributes['http.response.status_code']).toBe(401);
	});

	test('a thrown 5xx is an error, as it always was', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', () => {
			throw new HTTPException(503, { message: 'gateway down' });
		});

		await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(spans()[0]?.status).toBe('error');
		expect(spans()[0]?.error?.type).toBe('HTTPException');
	});

	/**
	 * A server span is precisely where a client disconnect or a request timeout
	 * shows up, and the reason `cancelled` exists is that a dashboard counting
	 * those as failures is a dashboard nobody trusts.
	 */
	test('an abort answered with a 500 stays cancelled', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', () => {
			const aborted = new Error('the caller went away');
			aborted.name = 'AbortError';
			throw aborted;
		});

		await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(spans()[0]?.status).toBe('cancelled');
		expect(spans()[0]?.error?.type).toBe('AbortError');
	});

	test('a middleware further down that throws marks the span too', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.use('*', async () => {
			throw new Error('policy refused');
		});
		app.get('/orders/:id', (c) => c.text('unreachable'));

		await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(spans()[0]?.status).toBe('error');
		expect(spans()[0]?.error?.message).toBe('policy refused');
	});

	/** An `onError` that answers 200 has decided the request was fine. */
	test('an onError that recovers leaves the span ok, with the failure recorded', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', () => {
			throw new Error('retried elsewhere');
		});
		app.onError((_failure, c) => c.text('recovered'));

		const reply = await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(reply.status).toBe(200);
		expect(spans()[0]?.status).toBe('ok');
		expect(spans()[0]?.error?.message).toBe('retried elsewhere');
	});
});

describe('a hook that throws', () => {
	/** A predicate that raises must not turn observability into an outage. */
	test('traced falls back to tracing the request', async () => {
		const tracing = telemetry({
			instance: instance(),
			traced: () => {
				throw new Error('no');
			},
		});
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', (c) => c.text('ok'));

		const reply = await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(reply.status).toBe(200);
		expect(spans()).toHaveLength(1);
	});

	test('spanName falls back to the method and the path', async () => {
		const tracing = telemetry({
			instance: instance(),
			spanName: () => {
				throw new Error('no');
			},
			route: () => undefined,
		});
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', (c) => c.text('ok'));

		const reply = await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(reply.status).toBe(200);
		expect(spans()[0]?.name).toBe('GET /orders/o-1');
	});
});

describe('the routing shapes it has to name', () => {
	test('a mounted sub-app reports the whole path', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		const orders = new Hono();
		orders.get('/:id', (c) => c.text('ok'));
		app.use('*', tracing);
		app.route('/api/orders', orders);

		await app.request('/api/orders/o-1');
		await tracing.telemetry.close();

		expect(spans()[0]?.name).toBe('GET /api/orders/:id');
	});

	test('a basePath is part of the route', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono().basePath('/v1');
		app.use('*', tracing);
		app.get('/orders/:id', (c) => c.text('ok'));

		await app.request('/v1/orders/o-1');
		await tracing.telemetry.close();

		expect(spans()[0]?.name).toBe('GET /v1/orders/:id');
	});

	/**
	 * The last matched route is a middleware registered after the routes; the
	 * last matched *handler* is the route. Taking the former gives one
	 * dashboard row per order id, which is the failure the rename exists to
	 * prevent.
	 */
	test('a middleware registered after the routes does not become the route', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/orders/:id', (c) => c.text('ok'));
		app.use('*', async (_c, next) => next());

		await app.request('/orders/o-1');
		await tracing.telemetry.close();

		expect(spans()[0]?.name).toBe('GET /orders/:id');
		expect(spans()[0]?.attributes['http.route']).toBe('/orders/:id');
	});

	/** A middleware that short-circuits still matched the route it guarded. */
	test('an auth middleware that answers 401 still names the route', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.use('/api/*', async (c) => c.text('no token', 401));
		app.get('/api/orders/:id', (c) => c.text('ok'));

		const reply = await app.request('/api/orders/o-1');
		await tracing.telemetry.close();

		expect(reply.status).toBe(401);
		expect(spans()[0]?.attributes['http.route']).toBe('/api/orders/:id');
		expect(spans()[0]?.status).toBe('ok');
	});

	test('a 404 under a basePath reports no route, like any other 404', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono().basePath('/v1');
		app.use('*', tracing);

		await app.request('/v1/nothing-here');
		await tracing.telemetry.close();

		expect(spans()[0]?.name).toBe('GET /v1/nothing-here');
		expect(spans()[0]?.attributes['http.route']).toBeUndefined();
	});

	/** A catch-all somebody registered on purpose is a route. */
	test('a wildcard route a handler owns is reported', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		app.use('*', tracing);
		app.get('/files/*', (c) => c.text('ok'));

		await app.request('/files/a/b.txt');
		await tracing.telemetry.close();

		expect(spans()[0]?.attributes['http.route']).toBe('/files/*');
	});
});

describe('two requests at once', () => {
	/**
	 * The invariant the library exists for, at the only place a server can
	 * break it: two requests in flight across an `await` must not see each
	 * other's span. A thread-local — or a module variable — gets this wrong,
	 * and gets it wrong silently, by joining two users into one trace.
	 */
	test('never see each other span, across an await', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		const seen = new Map<string, string | undefined>();

		app.use('*', tracing);
		app.get('/orders/:id', async (c) => {
			const id = c.req.param('id');
			const before = c.get('span')?.traceId;
			await new Promise((resolve) =>
				setTimeout(resolve, id === 'slow' ? 20 : 1),
			);
			const after = c.get('span')?.traceId;

			seen.set(id as string, before === after ? before : 'moved');
			return c.text('ok');
		});

		await Promise.all([
			app.request('/orders/slow'),
			app.request('/orders/fast'),
		]);
		await tracing.telemetry.close();

		expect(spans()).toHaveLength(2);
		expect(seen.get('slow')).not.toBe('moved');
		expect(seen.get('fast')).not.toBe('moved');
		expect(seen.get('slow')).not.toBe(seen.get('fast'));

		// And each span is one of the two, not one span seen twice.
		const traces = new Set(spans().map((one) => one.context.traceId));
		expect(traces.size).toBe(2);
	});

	test('a log written in each handler goes to its own trace', async () => {
		const tracing = telemetry({ instance: instance() });
		const app = new Hono();
		const log = createLogger('CheckoutService');

		app.use('*', tracing);
		app.get('/orders/:id', async (c) => {
			const id = c.req.param('id');
			await new Promise((resolve) =>
				setTimeout(resolve, id === 'slow' ? 20 : 1),
			);
			log.info('read', { id });
			return c.text('ok');
		});

		await Promise.all([
			app.request('/orders/slow'),
			app.request('/orders/fast'),
		]);
		await tracing.telemetry.close();

		const logs = collected.filter((one) => one.type === 'log');
		expect(logs).toHaveLength(2);
		expect(new Set(logs.map((one) => one.span?.traceId)).size).toBe(2);
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
