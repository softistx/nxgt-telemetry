import { describe, expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import type {
	LogRecord,
	Resource,
	SpanId,
	SpanRecord,
	TraceId,
} from '@nxgt/telemetry';
import {
	OtlpRefusedError,
	OtlpRejectedError,
	OtlpUnreachableError,
} from './errors';
import { otlpExporter } from './otlp';
import { RETRYABLE } from './transport';

const RESOURCE: Resource = { service: 'checkout', attributes: {} };
const ENDPOINT = 'http://collector:4318';

const LOG: LogRecord = {
	type: 'log',
	at: 0,
	severity: 'info',
	name: 'charged',
	source: 'spec',
	attributes: {},
};

const SPAN: SpanRecord = {
	type: 'span',
	name: 'charge',
	context: {
		traceId: '4bf92f3577b34da6a3ce929d0e0e4736' as TraceId,
		spanId: '00f067aa0ba902b7' as SpanId,
		sampled: true,
		remote: false,
	},
	kind: 'internal',
	startedAt: 0,
	endedAt: 1,
	status: 'ok',
	attributes: {},
	events: [],
};

interface Call {
	readonly url: string;
	readonly headers: Headers;
	readonly body: Uint8Array;
}

/** A collector that records what it was sent and answers what it was told to. */
function collector(
	answers: readonly (Response | Error)[] | (() => Response | Error),
): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	let taken = 0;

	const fetching = async (
		url: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		calls.push({
			url: String(url),
			headers: new Headers(init?.headers),
			body: new Uint8Array(init?.body as ArrayBuffer),
		});

		const answer =
			typeof answers === 'function'
				? answers()
				: (answers[Math.min(taken++, answers.length - 1)] as Response | Error);

		if (answer instanceof Error) throw answer;
		return answer.clone();
	};

	return { fetch: fetching as unknown as typeof fetch, calls };
}

function ok(): Response {
	return new Response('{}', { status: 200 });
}

const never = async (): Promise<void> => undefined;

function read(call: Call): unknown {
	const bytes =
		call.headers.get('content-encoding') === 'gzip'
			? gunzipSync(call.body)
			: call.body;
	return JSON.parse(new TextDecoder().decode(bytes));
}

describe('the requests it makes', () => {
	test('posts logs and traces to the two OTLP paths', async () => {
		const { fetch, calls } = collector([ok()]);
		await otlpExporter({ endpoint: ENDPOINT, fetch }).export(RESOURCE, [
			LOG,
			SPAN,
		]);

		expect(calls.map((call) => call.url).sort()).toEqual([
			'http://collector:4318/v1/logs',
			'http://collector:4318/v1/traces',
		]);
	});

	/** An empty document is a request worth not making. */
	test('sends one request when a batch is all logs', async () => {
		const { fetch, calls } = collector([ok()]);
		await otlpExporter({ endpoint: ENDPOINT, fetch }).export(RESOURCE, [LOG]);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('http://collector:4318/v1/logs');
	});

	test('sends nothing at all for an empty batch', async () => {
		const { fetch, calls } = collector([ok()]);
		await otlpExporter({ endpoint: ENDPOINT, fetch }).export(RESOURCE, []);

		expect(calls).toHaveLength(0);
	});

	test('a trailing slash on the endpoint does not become a double one', async () => {
		const { fetch, calls } = collector([ok()]);
		await otlpExporter({ endpoint: 'http://collector:4318//', fetch }).export(
			RESOURCE,
			[LOG],
		);

		expect(calls[0]?.url).toBe('http://collector:4318/v1/logs');
	});

	test('the paths can be pointed somewhere else', async () => {
		const { fetch, calls } = collector([ok()]);
		await otlpExporter({
			endpoint: ENDPOINT,
			logsPath: '/otlp/v1/logs',
			fetch,
		}).export(RESOURCE, [LOG]);

		expect(calls[0]?.url).toBe('http://collector:4318/otlp/v1/logs');
	});

	test('carries the headers it was given, and the JSON content type', async () => {
		const { fetch, calls } = collector([ok()]);
		await otlpExporter({
			endpoint: ENDPOINT,
			headers: { 'x-api-key': 'k' },
			fetch,
		}).export(RESOURCE, [LOG]);

		expect(calls[0]?.headers.get('content-type')).toBe('application/json');
		expect(calls[0]?.headers.get('x-api-key')).toBe('k');
	});

	test('the body is the OTLP document, and it round-trips', async () => {
		const { fetch, calls } = collector([ok()]);
		await otlpExporter({ endpoint: ENDPOINT, fetch }).export(RESOURCE, [LOG]);

		expect(read(calls[0] as Call)).toMatchObject({
			resourceLogs: [{ scopeLogs: [{ scope: { name: 'spec' } }] }],
		});
	});
});

describe('compression', () => {
	/** Below a kilobyte, compressing costs more than the bytes it saves. */
	test('a small document goes uncompressed', async () => {
		const { fetch, calls } = collector([ok()]);
		await otlpExporter({ endpoint: ENDPOINT, fetch }).export(RESOURCE, [LOG]);

		expect(calls[0]?.headers.get('content-encoding')).toBeNull();
	});

	test('a large one is gzipped, and says so', async () => {
		const { fetch, calls } = collector([ok()]);
		const many = Array.from({ length: 200 }, (_unused, index) => ({
			...LOG,
			name: `charged-${index}`,
		}));

		await otlpExporter({ endpoint: ENDPOINT, fetch }).export(RESOURCE, many);

		expect(calls[0]?.headers.get('content-encoding')).toBe('gzip');
		expect(read(calls[0] as Call)).toMatchObject({
			resourceLogs: [{ scopeLogs: [{ scope: { name: 'spec' } }] }],
		});
	});

	test('gzip false sends the bytes as they are, whatever the size', async () => {
		const { fetch, calls } = collector([ok()]);
		const many = Array.from({ length: 200 }, (_unused, index) => ({
			...LOG,
			name: `charged-${index}`,
		}));

		await otlpExporter({ endpoint: ENDPOINT, gzip: false, fetch }).export(
			RESOURCE,
			many,
		);

		expect(calls[0]?.headers.get('content-encoding')).toBeNull();
	});
});

describe('retrying', () => {
	test('retries a status the collector will recover from, then succeeds', async () => {
		const answers = [new Response('busy', { status: 503 }), ok()];
		const { fetch, calls } = collector(answers);

		await otlpExporter({
			endpoint: ENDPOINT,
			fetch,
			sleep: never,
		}).export(RESOURCE, [LOG]);

		expect(calls).toHaveLength(2);
	});

	test.each([...RETRYABLE])('retries %i', async (status) => {
		const { fetch, calls } = collector([
			new Response('busy', { status }),
			ok(),
		]);

		await otlpExporter({ endpoint: ENDPOINT, fetch, sleep: never }).export(
			RESOURCE,
			[LOG],
		);

		expect(calls).toHaveLength(2);
	});

	test('gives up after `attempts`, and says how many it made', async () => {
		const { fetch, calls } = collector(
			() => new Response('busy', { status: 503 }),
		);

		const failure = await otlpExporter({
			endpoint: ENDPOINT,
			attempts: 3,
			fetch,
			sleep: never,
		})
			.export(RESOURCE, [LOG])
			?.catch((thrown: unknown) => thrown);

		expect(calls).toHaveLength(3);
		expect(failure).toBeInstanceOf(OtlpRefusedError);
		expect((failure as OtlpRefusedError).status).toBe(503);
		expect((failure as OtlpRefusedError).attempts).toBe(3);
		expect((failure as OtlpRefusedError).body).toBe('busy');
	});

	/** Sending the same bytes again gets the same answer. */
	test('does not retry a rejection', async () => {
		const { fetch, calls } = collector(
			() => new Response('bad', { status: 400 }),
		);

		const failure = await otlpExporter({
			endpoint: ENDPOINT,
			fetch,
			sleep: never,
		})
			.export(RESOURCE, [LOG])
			?.catch((thrown: unknown) => thrown);

		expect(calls).toHaveLength(1);
		expect(failure).toBeInstanceOf(OtlpRejectedError);
		expect((failure as OtlpRejectedError).status).toBe(400);
	});

	test('retries a collector that never answers, then reports it unreachable', async () => {
		const { fetch, calls } = collector(() => new Error('ECONNREFUSED'));

		const failure = await otlpExporter({
			endpoint: ENDPOINT,
			attempts: 2,
			fetch,
			sleep: never,
		})
			.export(RESOURCE, [LOG])
			?.catch((thrown: unknown) => thrown);

		expect(calls).toHaveLength(2);
		expect(failure).toBeInstanceOf(OtlpUnreachableError);
		expect((failure as OtlpUnreachableError).cause).toBeInstanceOf(Error);
	});

	test('the backoff doubles, and is only waited between attempts', async () => {
		const waited: number[] = [];
		const { fetch } = collector(() => new Response('busy', { status: 503 }));

		await otlpExporter({
			endpoint: ENDPOINT,
			attempts: 4,
			backoff: 100,
			fetch,
			sleep: async (ms) => {
				waited.push(ms);
			},
		})
			.export(RESOURCE, [LOG])
			?.catch(() => undefined);

		expect(waited).toEqual([100, 200, 400]);
	});

	test('attempts 1 sends once and never waits', async () => {
		const waited: number[] = [];
		const { fetch, calls } = collector(
			() => new Response('busy', { status: 503 }),
		);

		await otlpExporter({
			endpoint: ENDPOINT,
			attempts: 1,
			fetch,
			sleep: async (ms) => {
				waited.push(ms);
			},
		})
			.export(RESOURCE, [LOG])
			?.catch(() => undefined);

		expect(calls).toHaveLength(1);
		expect(waited).toEqual([]);
	});

	test('truncates a collector that answers with a page of HTML', async () => {
		const { fetch } = collector(
			() => new Response('x'.repeat(2_000), { status: 400 }),
		);

		const failure = (await otlpExporter({ endpoint: ENDPOINT, fetch })
			.export(RESOURCE, [LOG])
			?.catch((thrown: unknown) => thrown)) as OtlpRejectedError;

		expect(failure.body).toHaveLength(501);
		expect(failure.body.endsWith('…')).toBe(true);
	});
});

describe('the two documents are independent', () => {
	/**
	 * A mixed batch is two requests. Logs failing must not cost the traces of
	 * the same batch, so both are sent before either failure is thrown.
	 */
	test('traces are still sent when logs are rejected', async () => {
		const seen: string[] = [];
		const answering = (async (url: string | URL | Request) => {
			seen.push(String(url));
			return String(url).endsWith('/v1/logs')
				? new Response('bad', { status: 400 })
				: ok();
		}) as unknown as typeof fetch;

		const failure = await otlpExporter({ endpoint: ENDPOINT, fetch: answering })
			.export(RESOURCE, [LOG, SPAN])
			?.catch((thrown: unknown) => thrown);

		expect(seen.sort()).toEqual([
			'http://collector:4318/v1/logs',
			'http://collector:4318/v1/traces',
		]);
		expect(failure).toBeInstanceOf(OtlpRejectedError);
	});

	/**
	 * The two documents go to two paths and can fail for unrelated reasons — a
	 * `400` on one and a refused connection on the other is not one outage.
	 * Reporting only the first loses the half of the story that says the
	 * collector is not simply down.
	 */
	test('both failures are reported when both documents fail', async () => {
		const answering = (async (url: string | URL | Request) => {
			if (String(url).endsWith('/v1/logs')) {
				return new Response('bad', { status: 400 });
			}
			throw new Error('ECONNREFUSED');
		}) as unknown as typeof fetch;

		const failure = (await otlpExporter({
			endpoint: ENDPOINT,
			attempts: 1,
			fetch: answering,
			sleep: never,
		})
			.export(RESOURCE, [LOG, SPAN])
			?.catch((thrown: unknown) => thrown)) as AggregateError;

		expect(failure).toBeInstanceOf(AggregateError);
		expect(failure.errors.map((one: Error) => one.name).sort()).toEqual([
			'OtlpRejectedError',
			'OtlpUnreachableError',
		]);
	});

	test('one failure is still thrown on its own, not wrapped', async () => {
		const answering = (async (url: string | URL | Request) =>
			String(url).endsWith('/v1/logs')
				? new Response('bad', { status: 400 })
				: ok()) as unknown as typeof fetch;

		const failure = await otlpExporter({
			endpoint: ENDPOINT,
			fetch: answering,
		})
			.export(RESOURCE, [LOG, SPAN])
			?.catch((thrown: unknown) => thrown);

		expect(failure).toBeInstanceOf(OtlpRejectedError);
	});
});

describe('the answer it does not need', () => {
	/**
	 * An unconsumed `Response` holds its connection out of the keep-alive pool
	 * until it is garbage-collected, and this is the path every successful
	 * export takes, once per linger interval, for the life of the process. The
	 * symptom is connection churn at the collector, which no test failure
	 * announces.
	 */
	test('cancels the body of an accepted request nobody asked about', async () => {
		let sent: Response | undefined;
		const answering = (async () => {
			sent = new Response('{}', { status: 200 });
			return sent;
		}) as unknown as typeof fetch;

		await otlpExporter({ endpoint: ENDPOINT, fetch: answering }).export(
			RESOURCE,
			[LOG],
		);

		expect(sent?.bodyUsed).toBe(true);
	});

	test('reads it instead when somebody asked', async () => {
		let sent: Response | undefined;
		const answering = (async () => {
			sent = new Response(JSON.stringify({ partialSuccess: {} }), {
				status: 200,
			});
			return sent;
		}) as unknown as typeof fetch;

		await otlpExporter({
			endpoint: ENDPOINT,
			fetch: answering,
			onPartialSuccess: () => undefined,
		}).export(RESOURCE, [LOG]);

		expect(sent?.bodyUsed).toBe(true);
	});
});

describe('the bound on a collector that does not answer', () => {
	/**
	 * `AbortSignal.timeout` is the only thing standing between a hung collector
	 * and an export that never settles — which, during `close()`, is the
	 * `drainTimeout` being spent on nothing.
	 */
	test('every attempt carries a timeout signal', async () => {
		const signals: (AbortSignal | null | undefined)[] = [];
		const answering = (async (
			_url: string | URL | Request,
			init?: RequestInit,
		) => {
			signals.push(init?.signal);
			return new Response('busy', { status: 503 });
		}) as unknown as typeof fetch;

		await otlpExporter({
			endpoint: ENDPOINT,
			attempts: 2,
			timeout: 25,
			fetch: answering,
			sleep: never,
		})
			.export(RESOURCE, [LOG])
			?.catch(() => undefined);

		expect(signals).toHaveLength(2);
		for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
	});

	test('a collector that never answers within the timeout is unreachable', async () => {
		const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(new Error('The operation timed out.')),
				);
			})) as unknown as typeof fetch;

		const failure = await otlpExporter({
			endpoint: ENDPOINT,
			attempts: 1,
			timeout: 20,
			fetch: hanging,
			sleep: never,
		})
			.export(RESOURCE, [LOG])
			?.catch((thrown: unknown) => thrown);

		expect(failure).toBeInstanceOf(OtlpUnreachableError);
	});
});

describe('what a failure is allowed to say', () => {
	/**
	 * A vendor's collector URL carries its key in the userinfo or the query
	 * string often enough that a failure must not be the thing that writes it
	 * to a log — and a failure is exactly what `onExportError` logs.
	 */
	test('a credential in the endpoint reaches neither the message nor the url', async () => {
		const { fetch } = collector(() => new Response('bad', { status: 400 }));

		const failure = (await otlpExporter({
			endpoint: 'https://user:s3cret@otlp.example',
			fetch,
		})
			.export(RESOURCE, [LOG])
			?.catch((thrown: unknown) => thrown)) as OtlpRejectedError;

		expect(failure.url).toBe('https://otlp.example/v1/logs');
		expect(failure.message).not.toContain('s3cret');
	});

	test('a key in the query string is dropped too', async () => {
		const { fetch } = collector(() => new Response('bad', { status: 400 }));

		const failure = (await otlpExporter({
			endpoint: 'https://otlp.example',
			logsPath: '/v1/logs?api-key=s3cret',
			fetch,
		})
			.export(RESOURCE, [LOG])
			?.catch((thrown: unknown) => thrown)) as OtlpRejectedError;

		expect(failure.message).not.toContain('s3cret');
		expect(failure.url).toBe('https://otlp.example/v1/logs');
	});
});

describe('partial success', () => {
	test('reports what the collector threw away, and does not retry it', async () => {
		const reports: unknown[] = [];
		const { fetch, calls } = collector(
			() =>
				new Response(
					JSON.stringify({
						partialSuccess: { rejectedLogRecords: '2', errorMessage: 'quota' },
					}),
					{ status: 200 },
				),
		);

		await otlpExporter({
			endpoint: ENDPOINT,
			fetch,
			onPartialSuccess: (report) => reports.push(report),
		}).export(RESOURCE, [LOG]);

		expect(calls).toHaveLength(1);
		expect(reports).toEqual([
			{ signal: 'logs', rejected: 2, message: 'quota' },
		]);
	});

	test('an empty partialSuccess is the ordinary answer, and says nothing', async () => {
		const reports: unknown[] = [];
		const { fetch } = collector(
			() =>
				new Response(JSON.stringify({ partialSuccess: {} }), { status: 200 }),
		);

		await otlpExporter({
			endpoint: ENDPOINT,
			fetch,
			onPartialSuccess: (report) => reports.push(report),
		}).export(RESOURCE, [LOG]);

		expect(reports).toEqual([]);
	});

	test('a body that is not JSON is still an accepted batch', async () => {
		const reports: unknown[] = [];
		const { fetch } = collector(() => new Response('', { status: 200 }));

		await otlpExporter({
			endpoint: ENDPOINT,
			fetch,
			onPartialSuccess: (report) => reports.push(report),
		}).export(RESOURCE, [LOG]);

		expect(reports).toEqual([]);
	});

	/** A reporting hook that throws must not become an export failure. */
	test('a hook that throws does not fail the export', async () => {
		const { fetch } = collector(
			() =>
				new Response(
					JSON.stringify({ partialSuccess: { rejectedSpans: '1' } }),
					{
						status: 200,
					},
				),
		);

		await otlpExporter({
			endpoint: ENDPOINT,
			fetch,
			onPartialSuccess: () => {
				throw new Error('no');
			},
		}).export(RESOURCE, [SPAN]);
	});
});
