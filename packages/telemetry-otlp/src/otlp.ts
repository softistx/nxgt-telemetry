import * as zlib from 'node:zlib';
import type { Exporter, Resource, Signal } from '@nxgt/telemetry';
import { logsRequest, tracesRequest } from './convert';
import {
	BODY_LIMIT,
	OtlpRefusedError,
	OtlpRejectedError,
	type OtlpSignal,
	OtlpUnreachableError,
} from './errors';
import type { PartialSuccess } from './wire';

export const DEFAULT_LOGS_PATH = '/v1/logs';
export const DEFAULT_TRACES_PATH = '/v1/traces';
export const DEFAULT_TIMEOUT = 10_000;
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF = 500;
/** Below this, compressing costs more than the bytes it saves. */
export const COMPRESSION_FLOOR = 1_024;

/**
 * The statuses worth sending the same bytes again for. Everything else is the
 * collector saying the request is wrong, and a retry would only repeat it.
 */
export const RETRYABLE: ReadonlySet<number> = new Set([
	408, 429, 500, 502, 503, 504,
]);

/** What a collector accepted with reservations. */
export interface PartialSuccessReport {
	readonly signal: OtlpSignal;
	/** How many records the collector threw away. */
	readonly rejected: number;
	readonly message: string;
}

export interface OtlpExporterOptions {
	/** The collector's base URL, e.g. `http://localhost:4318`. */
	readonly endpoint: string;
	/** Appended to `endpoint`. Default `/v1/logs`. */
	readonly logsPath?: string;
	/** Appended to `endpoint`. Default `/v1/traces`. */
	readonly tracesPath?: string;
	/** Sent on every request — an API key, a tenant. */
	readonly headers?: Readonly<Record<string, string>>;
	/** Per attempt, in milliseconds. Default 10s. */
	readonly timeout?: number;
	/** How many requests one document gets. Default 3. `1` disables retrying. */
	readonly attempts?: number;
	/** The first wait between attempts, doubled each time. Default 500ms. */
	readonly backoff?: number;
	/** Gzip a document over 1 KiB. Default true. */
	readonly gzip?: boolean;
	/** Called when the collector accepted the request but not every record. */
	readonly onPartialSuccess?: (report: PartialSuccessReport) => void;
	/** For specs, and for an application that routes its own traffic. */
	readonly fetch?: typeof fetch;
	/** For specs. Default a real `setTimeout`. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Logs and traces to an OpenTelemetry collector, as OTLP/HTTP JSON.
 *
 * ```ts
 * otlpExporter({ endpoint: 'http://localhost:4318', headers: { 'x-api-key': key } })
 * ```
 *
 * There is no OpenTelemetry SDK behind this. OTLP is a wire format, and the
 * whole of it that a collector needs is two JSON documents over `fetch` — which
 * is what lets this package have one dependency and no transitive tree, and
 * what keeps the context in `AsyncLocalStorage` instead of in the Java SDK's
 * thread-local shape.
 *
 * A mixed batch is **two requests**, one per document, sent together: logs
 * failing must not cost the traces of the same batch. Either failure is thrown,
 * which means it reaches `onExportError` and nothing else.
 */
export function otlpExporter(options: OtlpExporterOptions): Exporter {
	const endpoint = options.endpoint.replace(/\/+$/, '');
	const logsUrl = endpoint + (options.logsPath ?? DEFAULT_LOGS_PATH);
	const tracesUrl = endpoint + (options.tracesPath ?? DEFAULT_TRACES_PATH);
	const timeout = options.timeout ?? DEFAULT_TIMEOUT;
	const attempts = Math.max(options.attempts ?? DEFAULT_ATTEMPTS, 1);
	const backoff = options.backoff ?? DEFAULT_BACKOFF;
	const compress = options.gzip ?? true;
	const call = options.fetch ?? fetch;
	const sleep = options.sleep ?? wait;

	const send = async (
		url: string,
		signal: OtlpSignal,
		document: unknown,
	): Promise<void> => {
		const body = await encode(JSON.stringify(document), compress);

		let failure: unknown;
		let waited = backoff;

		for (let attempt = 1; attempt <= attempts; attempt++) {
			if (attempt > 1) {
				await sleep(waited);
				waited *= 2;
			}

			let reply: Response;
			try {
				reply = await call(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(body.encoded ? { 'content-encoding': 'gzip' } : {}),
						...options.headers,
					},
					body: body.bytes,
					signal: AbortSignal.timeout(timeout),
				});
			} catch (thrown) {
				// No answer at all: DNS, a refused connection, the timeout.
				failure = thrown;
				continue;
			}

			if (reply.ok) {
				// The body is only read when somebody asked to hear about it:
				// the ordinary answer is empty, and parsing it is work.
				if (options.onPartialSuccess !== undefined) {
					report(signal, await partialSuccess(reply), options.onPartialSuccess);
				}
				return;
			}

			const text = truncate(await bodyOf(reply));

			if (!RETRYABLE.has(reply.status)) {
				// The same bytes would get the same answer.
				throw new OtlpRejectedError(url, signal, attempt, reply.status, text);
			}

			failure = new OtlpRefusedError(url, signal, attempt, reply.status, text);
		}

		if (failure instanceof OtlpRefusedError) throw failure;
		throw new OtlpUnreachableError(url, signal, attempts, failure);
	};

	return {
		async export(resource: Resource, batch: readonly Signal[]): Promise<void> {
			const logs = logsRequest(resource, batch);
			const traces = tracesRequest(resource, batch);

			const sent = await Promise.allSettled([
				logs === undefined ? undefined : send(logsUrl, 'logs', logs),
				traces === undefined ? undefined : send(tracesUrl, 'traces', traces),
			]);

			// Both were attempted; the first failure is the one reported, and
			// the other is not swallowed silently — it is the same outage.
			const rejected = sent.find((one) => one.status === 'rejected');
			if (rejected?.status === 'rejected') throw rejected.reason;
		},
	};
}

/**
 * A partial success is **not retried**. The collector took the request and
 * decided about each record in it; sending the same bytes again would duplicate
 * everything it did accept.
 */
function report(
	signal: OtlpSignal,
	found: PartialSuccess | undefined,
	onPartialSuccess: (report: PartialSuccessReport) => void,
): void {
	if (found === undefined) return;

	const rejected = Number(found.rejectedLogRecords ?? found.rejectedSpans ?? 0);
	const message = found.errorMessage ?? '';
	if (rejected === 0 && message === '') return;

	try {
		onPartialSuccess({ signal, rejected, message });
	} catch {
		// A reporting hook that throws must not become an export failure.
	}
}

async function partialSuccess(
	reply: Response,
): Promise<PartialSuccess | undefined> {
	try {
		const answered = (await reply.json()) as {
			partialSuccess?: PartialSuccess;
		} | null;
		return answered?.partialSuccess;
	} catch {
		// An empty body is the ordinary answer, and a collector that sends
		// something else has still accepted the batch.
		return undefined;
	}
}

async function bodyOf(reply: Response): Promise<string> {
	try {
		return await reply.text();
	} catch {
		return '';
	}
}

function truncate(text: string): string {
	return text.length <= BODY_LIMIT ? text : `${text.slice(0, BODY_LIMIT)}…`;
}

/**
 * Gzip when it is worth it, and only where `node:zlib` exists. A bundle for the
 * browser that shims the builtin away still exports — uncompressed, which every
 * collector accepts — rather than failing to load.
 */
async function encode(
	json: string,
	compress: boolean,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; encoded: boolean }> {
	const bytes = new TextEncoder().encode(json);
	if (!compress || bytes.byteLength < COMPRESSION_FLOOR) {
		return { bytes, encoded: false };
	}

	// A bundler that shims `node:zlib` to an empty module leaves this
	// undefined, whatever the types say.
	const { gzip } = zlib as Partial<typeof zlib>;
	if (typeof gzip !== 'function') return { bytes, encoded: false };

	return new Promise((resolve) => {
		gzip(bytes, (failure, result) => {
			resolve(
				failure
					? { bytes, encoded: false }
					: // `zlib` answers a `Buffer`, whose buffer is typed as
						// `ArrayBufferLike` — which `BodyInit` excludes because it
						// admits a `SharedArrayBuffer`. This one never is.
						{ bytes: result as Uint8Array<ArrayBuffer>, encoded: true },
			);
		});
	});
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		// A retry in flight must not be the reason a process will not exit.
		timer.unref?.();
	});
}
