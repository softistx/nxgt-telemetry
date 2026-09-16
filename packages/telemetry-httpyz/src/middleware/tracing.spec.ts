import { beforeEach, describe, expect, test } from 'bun:test';
import type { CallContext } from '@nxgt/httpyz';
import {
	createLogger,
	createTelemetry,
	type Exporter,
	parseTraceparent,
	type Resource,
	type Signal,
	type SpanRecord,
	span,
	withTelemetry,
} from '@nxgt/telemetry';
import { TRACEPARENT, tracing, UNNAMED } from './tracing';

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

function instance() {
	return createTelemetry('checkout', { exporters: [collecting()], batch: 1 });
}

const CALL: CallContext = { method: 'GET', path: '/employees/{id}' };

/** The request the middleware handed on, and the answer it was given. */
function sending(reply: () => Response = () => new Response('{}')) {
	const sent: Request[] = [];
	const next = async (request: Request): Promise<Response> => {
		sent.push(request);
		return reply();
	};
	return { next, sent };
}

beforeEach(() => {
	collected = [];
});

describe('the span it opens', () => {
	test('is a client span named for the path template, not the filled path', async () => {
		const telemetry = instance();
		const { next } = sending();

		await withTelemetry(telemetry, () =>
			tracing()(new Request('https://api.example/employees/e-1'), next, CALL),
		);
		await telemetry.close();

		expect(spans()[0]?.name).toBe('GET /employees/{id}');
		expect(spans()[0]?.kind).toBe('client');
	});

	test('prefers the operationId when the call has one', async () => {
		const telemetry = instance();
		const { next } = sending();

		await withTelemetry(telemetry, () =>
			tracing()(new Request('https://api.example/employees/e-1'), next, {
				...CALL,
				operationId: 'readEmployee',
			}),
		);
		await telemetry.close();

		expect(spans()[0]?.name).toBe('readEmployee');
		expect(spans()[0]?.attributes['http.operation']).toBe('readEmployee');
	});

	/**
	 * `@nxgt/httpyz` passes the method as the caller wrote it — `api.get(…)`
	 * gives `'get'` — and the conventions want `GET`, so a dashboard grouping
	 * by method does not end up with two of each.
	 */
	test('uppercases the method, whatever the caller wrote', async () => {
		const telemetry = instance();
		const { next } = sending();

		await withTelemetry(telemetry, () =>
			tracing()(
				new Request('https://api.example/x', { method: 'POST' }),
				next,
				{
					method: 'post',
					path: '/employees',
				},
			),
		);
		await telemetry.close();

		expect(spans()[0]?.name).toBe('POST /employees');
		expect(spans()[0]?.attributes['http.request.method']).toBe('POST');
	});

	test('records the method, the URL, the host and the status', async () => {
		const telemetry = instance();
		const { next } = sending(() => new Response('{}', { status: 201 }));

		await withTelemetry(telemetry, () =>
			tracing()(
				new Request('https://api.example:8443/employees/e-1?page=2', {
					method: 'POST',
				}),
				next,
				{ ...CALL, method: 'POST' },
			),
		);
		await telemetry.close();

		expect(spans()[0]?.attributes).toMatchObject({
			'http.request.method': 'POST',
			'url.full': 'https://api.example:8443/employees/e-1?page=2',
			'url.template': '/employees/{id}',
			'server.address': 'api.example',
			'server.port': 8443,
			'http.response.status_code': 201,
		});
	});

	/**
	 * A span is read by everybody who reads the dashboard, and
	 * `https://user:token@api.example` is a real way to carry a credential.
	 */
	test('strips the userinfo from the URL it records', async () => {
		const telemetry = instance();
		const { next } = sending();

		await withTelemetry(telemetry, () =>
			tracing()(
				new Request('https://user:s3cret@api.example/employees/e-1'),
				next,
				CALL,
			),
		);
		await telemetry.close();

		expect(spans()[0]?.attributes['url.full']).toBe(
			'https://api.example/employees/e-1',
		);
		expect(JSON.stringify(spans()[0])).not.toContain('s3cret');
	});

	test('a url hook that answers nothing records no URL', async () => {
		const telemetry = instance();
		const { next } = sending();

		await withTelemetry(telemetry, () =>
			tracing({ url: () => undefined })(
				new Request('https://api.example/employees/e-1?key=s3cret'),
				next,
				CALL,
			),
		);
		await telemetry.close();

		expect(spans()[0]?.attributes['url.full']).toBeUndefined();
		expect(JSON.stringify(spans()[0])).not.toContain('s3cret');
	});
});

describe('the status it reads', () => {
	/**
	 * Where a client span and a server span disagree, and the asymmetry is the
	 * point: a 404 answered by a server is that server working; the same 404
	 * received by a caller is a call that did not do what it was for.
	 */
	test('a 404 is an error here, unlike on the server side', async () => {
		const telemetry = instance();
		const { next } = sending(() => new Response('', { status: 404 }));

		await withTelemetry(telemetry, () =>
			tracing()(new Request('https://api.example/employees/e-1'), next, CALL),
		);
		await telemetry.close();

		expect(spans()[0]?.status).toBe('error');
		expect(spans()[0]?.attributes['http.response.status_code']).toBe(404);
	});

	test('a 2xx and a 3xx are ok', async () => {
		const telemetry = instance();

		for (const status of [200, 204, 304]) {
			const { next } = sending(() => new Response(null, { status }));
			await withTelemetry(telemetry, () =>
				tracing()(new Request('https://api.example/x'), next, CALL),
			);
		}
		await telemetry.close();

		expect(spans().map((one) => one.status)).toEqual(['ok', 'ok', 'ok']);
	});

	test('a failure on the way out is recorded and rethrown', async () => {
		const telemetry = instance();
		const next = async (): Promise<Response> => {
			throw new Error('ECONNREFUSED');
		};

		await expect(
			withTelemetry(telemetry, () =>
				tracing()(new Request('https://api.example/x'), next, CALL),
			),
		).rejects.toThrow('ECONNREFUSED');
		await telemetry.close();

		expect(spans()[0]?.status).toBe('error');
		expect(spans()[0]?.error?.message).toBe('ECONNREFUSED');
	});

	/** A timeout is not a failure — which is the whole reason that status exists. */
	test('a timeout is cancelled, not an error', async () => {
		const telemetry = instance();
		const next = async (): Promise<Response> => {
			const timedOut = new Error('the call took too long');
			timedOut.name = 'TimeoutError';
			throw timedOut;
		};

		await expect(
			withTelemetry(telemetry, () =>
				tracing()(new Request('https://api.example/x'), next, CALL),
			),
		).rejects.toThrow();
		await telemetry.close();

		expect(spans()[0]?.status).toBe('cancelled');
	});
});

describe('the header it sends', () => {
	test('carries this span, so the other end continues the trace', async () => {
		const telemetry = instance();
		const { next, sent } = sending();

		await withTelemetry(telemetry, () =>
			tracing()(new Request('https://api.example/x'), next, CALL),
		);
		await telemetry.close();

		const header = sent[0]?.headers.get(TRACEPARENT);
		const parsed = parseTraceparent(header);
		expect(parsed?.traceId).toBe(spans()[0]?.context.traceId);
		expect(parsed?.spanId).toBe(spans()[0]?.context.spanId);
	});

	/**
	 * The point of the whole package: a server span, a client call inside it,
	 * and one trace across the two.
	 */
	test('inside a server span, it continues that trace', async () => {
		const telemetry = instance();
		const { next, sent } = sending();

		await withTelemetry(telemetry, () =>
			span('GET /orders/:id', { kind: 'server' }, async () =>
				tracing()(new Request('https://api.example/x'), next, CALL),
			),
		);
		await telemetry.close();

		const server = spans().find((one) => one.kind === 'server');
		const client = spans().find((one) => one.kind === 'client');
		const parsed = parseTraceparent(sent[0]?.headers.get(TRACEPARENT));

		expect(client?.context.traceId).toBe(server?.context.traceId);
		expect(client?.parent).toBe(server?.context.spanId);
		expect(parsed?.traceId).toBe(server?.context.traceId);
		expect(parsed?.spanId).toBe(client?.context.spanId);
	});

	test('replaces a stale traceparent rather than sending two traces', async () => {
		const telemetry = instance();
		const { next, sent } = sending();
		const stale = '00-00000000000000000000000000000001-0000000000000002-01';

		await withTelemetry(telemetry, () =>
			tracing()(
				new Request('https://api.example/x', {
					headers: { traceparent: stale },
				}),
				next,
				CALL,
			),
		);
		await telemetry.close();

		expect(sent[0]?.headers.get(TRACEPARENT)).not.toBe(stale);
	});

	/**
	 * A library that traces has to work inside an application that has never
	 * heard of this one.
	 */
	test('outside any telemetry the call still goes out', async () => {
		const { next, sent } = sending();

		const reply = await tracing()(
			new Request('https://api.example/x'),
			next,
			CALL,
		);

		expect(reply.status).toBe(200);
		expect(sent).toHaveLength(1);
		expect(collected).toHaveLength(0);
	});

	/**
	 * A detached scope's `traceparent()` is all zeros, which this library's own
	 * parser rejects and which W3C calls invalid. Sending it is worse than
	 * sending nothing: a strict receiver refuses the request, and a lenient one
	 * starts a fresh trace exactly as an absent header would.
	 */
	test('sends no header at all when there is no telemetry', async () => {
		const { next, sent } = sending();

		await tracing()(new Request('https://api.example/x'), next, CALL);

		expect(sent[0]?.headers.get(TRACEPARENT)).toBeNull();
	});

	test('leaves an inbound header alone when it has no trace of its own', async () => {
		const { next, sent } = sending();
		const theirs = '00-00000000000000000000000000000001-0000000000000002-01';

		await tracing()(
			new Request('https://api.example/x', {
				headers: { traceparent: theirs },
			}),
			next,
			CALL,
		);

		expect(sent[0]?.headers.get(TRACEPARENT)).toBe(theirs);
	});

	test('a request whose headers cannot be set still goes out', async () => {
		const telemetry = instance();
		const { next, sent } = sending();
		const frozen = new Request('https://api.example/x');
		Object.defineProperty(frozen.headers, 'set', {
			value: () => {
				throw new TypeError('immutable');
			},
		});

		await withTelemetry(telemetry, () => tracing()(frozen, next, CALL));
		await telemetry.close();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.headers.get(TRACEPARENT)).not.toBeNull();
		expect(spans()).toHaveLength(1);
	});

	/**
	 * The copy is the interesting half of that fallback: a request that lost its
	 * body, its method or its signal on the way through would be a call that
	 * silently did something else.
	 */
	test('the copy keeps the method, the body, the headers and the signal', async () => {
		const telemetry = instance();
		const { next, sent } = sending();
		const controller = new AbortController();
		const frozen = new Request('https://api.example/employees', {
			method: 'POST',
			body: JSON.stringify({ name: 'Ada' }),
			headers: { 'content-type': 'application/json', 'x-tenant': 'acme' },
			signal: controller.signal,
		});
		Object.defineProperty(frozen.headers, 'set', {
			value: () => {
				throw new TypeError('immutable');
			},
		});

		await withTelemetry(telemetry, () =>
			tracing()(frozen, next, { method: 'post', path: '/employees' }),
		);
		await telemetry.close();

		const copy = sent[0] as Request;
		expect(copy.method).toBe('POST');
		expect(copy.url).toBe('https://api.example/employees');
		expect(copy.headers.get('x-tenant')).toBe('acme');
		expect(copy.headers.get(TRACEPARENT)).not.toBeNull();
		expect(await copy.json()).toEqual({ name: 'Ada' });

		// The original is untouched: a copy that consumed it would leave the
		// caller holding a request it can no longer send.
		expect(frozen.bodyUsed).toBe(false);

		controller.abort();
		expect(copy.signal.aborted).toBe(true);
	});

	/** A span has to be called something; failing the call over its name would
	 * be the tracing library causing the outage. */
	test('a call context it cannot read still produces a span', async () => {
		const telemetry = instance();
		const { next, sent } = sending();
		const hostile = new Proxy({} as CallContext, {
			get() {
				throw new Error('nope');
			},
		});

		await withTelemetry(telemetry, () =>
			tracing()(new Request('https://api.example/x'), next, hostile),
		);
		await telemetry.close();

		expect(sent).toHaveLength(1);
		expect(spans()).toHaveLength(1);
		expect(spans()[0]?.name).toBe(UNNAMED);
		expect(spans()[0]?.attributes['http.response.status_code']).toBe(200);
	});
});

describe('traced', () => {
	test('a call it refuses gets no span, and no header', async () => {
		const telemetry = instance();
		const { next, sent } = sending();

		await withTelemetry(telemetry, () =>
			tracing({ traced: (call) => call.path !== '/health' })(
				new Request('https://api.example/health'),
				next,
				{ method: 'GET', path: '/health' },
			),
		);
		await telemetry.close();

		expect(spans()).toHaveLength(0);
		expect(sent[0]?.headers.get(TRACEPARENT)).toBeNull();
	});

	test('nothing is skipped by default', async () => {
		const telemetry = instance();
		const { next } = sending();

		await withTelemetry(telemetry, () =>
			tracing()(new Request('https://api.example/health'), next, CALL),
		);
		await telemetry.close();

		expect(spans()).toHaveLength(1);
	});
});

describe('a hook that throws', () => {
	test('traced falls back to tracing the call', async () => {
		const telemetry = instance();
		const { next } = sending();

		await withTelemetry(telemetry, () =>
			tracing({
				traced: () => {
					throw new Error('no');
				},
			})(new Request('https://api.example/x'), next, CALL),
		);
		await telemetry.close();

		expect(spans()).toHaveLength(1);
	});

	test('spanName falls back to the default name', async () => {
		const telemetry = instance();
		const { next } = sending();

		await withTelemetry(telemetry, () =>
			tracing({
				spanName: () => {
					throw new Error('no');
				},
			})(new Request('https://api.example/x'), next, CALL),
		);
		await telemetry.close();

		expect(spans()[0]?.name).toBe('GET /employees/{id}');
	});

	test('url falls back to recording none', async () => {
		const telemetry = instance();
		const { next } = sending();

		await withTelemetry(telemetry, () =>
			tracing({
				url: () => {
					throw new Error('no');
				},
			})(new Request('https://api.example/x'), next, CALL),
		);
		await telemetry.close();

		expect(spans()[0]?.attributes['url.full']).toBeUndefined();
		expect(spans()).toHaveLength(1);
	});
});

describe('what the call can write', () => {
	test('a log inside the call carries the client span', async () => {
		const telemetry = instance();
		const log = createLogger('ApiClient');
		const next = async (request: Request): Promise<Response> => {
			void request;
			log.info('sent');
			return new Response('{}');
		};

		await withTelemetry(telemetry, () =>
			tracing()(new Request('https://api.example/x'), next, CALL),
		);
		await telemetry.close();

		const written = collected.find((one) => one.type === 'log');
		expect(written?.type === 'log' && written.span?.spanId).toBe(
			spans()[0]?.context.spanId,
		);
	});
});
