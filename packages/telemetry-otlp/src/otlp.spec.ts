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
import { otlpExporter, RETRYABLE } from './otlp';

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
