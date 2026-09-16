import * as zlib from 'node:zlib';
import type { PartialSuccess } from '../wire/documents';
import {
	BODY_LIMIT,
	OtlpRefusedError,
	OtlpRejectedError,
	type OtlpSignal,
	OtlpUnreachableError,
} from './errors';

export const DEFAULT_TIMEOUT = 10_000;
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF = 500;
/** Below this, compressing costs more than the bytes it saves. */
export const COMPRESSION_FLOOR = 1_024;

/** `null` where `node:zlib` was shimmed away — a browser bundle, usually. */
const AVAILABLE_GZIP: typeof zlib.gzip | null =
	(zlib as Partial<typeof zlib>).gzip ?? null;

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

/** Everything `post` needs, resolved once when the exporter is built. */
export interface Transport {
	readonly headers: Readonly<Record<string, string>>;
	readonly timeout: number;
	readonly attempts: number;
	readonly backoff: number;
	readonly gzip: boolean;
	readonly onPartialSuccess?: (report: PartialSuccessReport) => void;
	readonly fetch: typeof fetch;
	readonly sleep: (ms: number) => Promise<void>;
}

/**
 * One document to one URL, retried to the end of `attempts`.
 *
 * The body is encoded **once**, before the loop: a retry sends the same bytes,
 * and gzipping them again each time would be work for nothing.
 */
export async function post(
	transport: Transport,
	url: string,
	signal: OtlpSignal,
	document: unknown,
): Promise<void> {
	const body = await encode(JSON.stringify(document), transport.gzip);
	const named = safeUrl(url);

	let failure: unknown;
	let waited = transport.backoff;

	for (let attempt = 1; attempt <= transport.attempts; attempt++) {
		if (attempt > 1) {
			await transport.sleep(waited);
			waited *= 2;
		}

		let reply: Response;
		try {
			reply = await transport.fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(body.encoded ? { 'content-encoding': 'gzip' } : {}),
					...transport.headers,
				},
				body: body.bytes,
				signal: AbortSignal.timeout(transport.timeout),
			});
		} catch (thrown) {
			// No answer at all: DNS, a refused connection, the timeout.
			failure = thrown;
			continue;
		}

		if (reply.ok) {
			await accepted(transport, signal, reply);
			return;
		}

		const text = truncate(await bodyOf(reply));

		if (!RETRYABLE.has(reply.status)) {
			// The same bytes would get the same answer.
			throw new OtlpRejectedError(named, signal, attempt, reply.status, text);
		}

		failure = new OtlpRefusedError(named, signal, attempt, reply.status, text);
	}

	if (failure instanceof OtlpRefusedError) throw failure;
	throw new OtlpUnreachableError(named, signal, transport.attempts, failure);
}

/**
 * The collector took the request. Its body still has to be read or cancelled:
 * an unconsumed `Response` holds its connection out of the keep-alive pool
 * until it is collected, and this is the path every successful export takes,
 * once per linger interval, for the life of the process.
 */
async function accepted(
	transport: Transport,
	signal: OtlpSignal,
	reply: Response,
): Promise<void> {
	if (transport.onPartialSuccess === undefined) {
		// Nobody asked what it said, and the ordinary answer is empty.
		await reply.body?.cancel().catch(() => undefined);
		return;
	}

	report(signal, await partialSuccess(reply), transport.onPartialSuccess);
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
 * The URL as it may be repeated in an error message and read by whatever
 * `onExportError` logs to — **without its credentials**. A collector URL of the
 * shape `https://user:token@otlp.vendor.example/v1/logs` and one with the key
 * in the query string are both things vendors hand out, and a failure is not a
 * reason to put either in a log line.
 */
export function safeUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.username = '';
		parsed.password = '';
		parsed.search = '';
		parsed.hash = '';
		return parsed.toString();
	} catch {
		// Not a URL this runtime can parse; `fetch` will say so in its own way.
		return url;
	}
}

/**
 * Gzip when it is worth it, and only where `node:zlib` exists. A bundle for the
 * browser that shims the builtin away still exports — uncompressed, which every
 * collector accepts — rather than failing to load.
 */
export async function encode(
	json: string,
	compress: boolean,
	// `null` is "there is no gzip here", which is what a bundler that shims
	// `node:zlib` to an empty module leaves behind, whatever the types say. It
	// is a parameter so a spec can reach that branch without mocking a builtin.
	gzip: typeof zlib.gzip | null = AVAILABLE_GZIP,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; encoded: boolean }> {
	const bytes = new TextEncoder().encode(json);
	if (!compress || bytes.byteLength < COMPRESSION_FLOOR) {
		return { bytes, encoded: false };
	}

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

export function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		// A retry in flight must not be the reason a process will not exit.
		timer.unref?.();
	});
}
