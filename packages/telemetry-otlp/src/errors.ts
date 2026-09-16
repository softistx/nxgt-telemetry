/** Which document failed. A mixed batch is two requests, and either can fail. */
export type OtlpSignal = 'logs' | 'traces';

/** How much of a collector's answer is kept. Enough to read; not a log flood. */
export const BODY_LIMIT = 500;

/**
 * The shared shape. All three are thrown out of `export`, which means they
 * reach `onExportError` and nothing else: a collector being down is not a
 * reason for a request to fail.
 *
 * They are plain classes with a `name` rather than a discriminated union
 * because that is what a `catch` reads, and `instanceof` across two copies of
 * this package would answer false.
 */
export abstract class OtlpError extends Error {
	readonly endpoint: string;
	readonly signal: OtlpSignal;
	/** How many requests were made, including the one that failed. */
	readonly attempts: number;

	constructor(
		message: string,
		endpoint: string,
		signal: OtlpSignal,
		attempts: number,
	) {
		super(message);
		this.endpoint = endpoint;
		this.signal = signal;
		this.attempts = attempts;
	}
}

/**
 * The collector never answered: DNS, a refused connection, a timeout. Retried
 * to the end of `attempts` before this is thrown.
 */
export class OtlpUnreachableError extends OtlpError {
	override readonly name = 'OtlpUnreachableError';
	/** What `fetch` threw on the last attempt. */
	readonly cause: unknown;

	constructor(
		endpoint: string,
		signal: OtlpSignal,
		attempts: number,
		cause: unknown,
	) {
		super(
			`[telemetry] ${endpoint} did not answer for ${signal} after ${attempts} attempt(s)`,
			endpoint,
			signal,
			attempts,
		);
		this.cause = cause;
	}
}

/**
 * The collector answered, and kept answering, with a status worth retrying —
 * `408`, `429`, or a `5xx` it declares. The queue it was busy with is still
 * busy.
 */
export class OtlpRefusedError extends OtlpError {
	override readonly name = 'OtlpRefusedError';
	readonly status: number;
	/** The first `BODY_LIMIT` characters of the last answer. */
	readonly body: string;

	constructor(
		endpoint: string,
		signal: OtlpSignal,
		attempts: number,
		status: number,
		body: string,
	) {
		super(
			`[telemetry] ${endpoint} refused ${signal} with ${status} after ${attempts} attempt(s): ${body}`,
			endpoint,
			signal,
			attempts,
		);
		this.status = status;
		this.body = body;
	}
}

/**
 * The collector rejected the request outright — a bad path, a missing header, a
 * document it will not accept. **Not retried**: sending the same bytes again
 * gets the same answer, and the batch is lost either way.
 */
export class OtlpRejectedError extends OtlpError {
	override readonly name = 'OtlpRejectedError';
	readonly status: number;
	/** The first `BODY_LIMIT` characters of the answer. */
	readonly body: string;

	constructor(
		endpoint: string,
		signal: OtlpSignal,
		attempts: number,
		status: number,
		body: string,
	) {
		super(
			`[telemetry] ${endpoint} rejected ${signal} with ${status}: ${body}`,
			endpoint,
			signal,
			attempts,
		);
		this.status = status;
		this.body = body;
	}
}
