import type { ErrorInfo } from './signal';

/**
 * A thrown value, flattened onto the wire.
 *
 * It accepts anything, because `throw` accepts anything: a string, a plain
 * object and a rejected promise carrying neither all reach here, and a span
 * that refused to record one would turn an application's bug into this
 * library's.
 */
export function errorInfo(failure: unknown, stackTraces = true): ErrorInfo {
	if (failure instanceof Error) {
		return {
			type: failure.name || 'Error',
			...(failure.message ? { message: failure.message } : {}),
			...(stackTraces && failure.stack ? { stackTrace: failure.stack } : {}),
		};
	}

	return { type: typeName(failure), message: describe(failure) };
}

/**
 * Whether a failure is work that was called off rather than work that broke.
 *
 * `cancelled` is a status of its own so that a shutdown and a timeout do not
 * read as failures — a dashboard that counts them as such is a dashboard nobody
 * trusts. `AbortError` is what an `AbortSignal` rejects with, and `TimeoutError`
 * is what `AbortSignal.timeout` rejects with.
 */
export function isAbort(failure: unknown): boolean {
	const name = (failure as { name?: unknown } | null)?.name;
	return name === 'AbortError' || name === 'TimeoutError';
}

function typeName(failure: unknown): string {
	if (failure === null) return 'null';
	if (typeof failure !== 'object') return typeof failure;

	try {
		return failure.constructor?.name || 'Object';
	} catch {
		return 'Object';
	}
}

function describe(failure: unknown): string {
	try {
		return typeof failure === 'object' && failure !== null
			? JSON.stringify(failure) || String(failure)
			: String(failure);
	} catch {
		return '[unrenderable]';
	}
}
