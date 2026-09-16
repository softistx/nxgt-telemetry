import { UNREADABLE } from '../attributes/attributes';
import type { ErrorInfo } from './signal';

/**
 * A thrown value, flattened onto the wire.
 *
 * **Nothing here can throw.** `throw` accepts anything — a string, a Proxy, an
 * `Error` subclass with a getter that raises, an object from another realm —
 * and this runs inside a `catch`, where a second failure would replace the
 * application's first one and lose it. Every property read is guarded, and a
 * value it cannot read at all still produces a record.
 */
export function errorInfo(failure: unknown, stackTraces = true): ErrorInfo {
	try {
		return flatten(failure, stackTraces);
	} catch {
		return { type: 'Error', message: UNREADABLE };
	}
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
	if (typeof failure !== 'object' || failure === null) return false;
	const name = read(failure, 'name');
	return name === 'AbortError' || name === 'TimeoutError';
}

function flatten(failure: unknown, stackTraces: boolean): ErrorInfo {
	if (isError(failure)) {
		const message = read(failure, 'message');
		const stack = stackTraces ? read(failure, 'stack') : undefined;

		return {
			type: errorType(failure),
			...(typeof message === 'string' && message ? { message } : {}),
			...(typeof stack === 'string' && stack ? { stackTrace: stack } : {}),
		};
	}

	return { type: typeName(failure), message: describe(failure) };
}

/**
 * `instanceof` is realm-bound: an `Error` from a worker, a `vm` context or an
 * iframe is not an instance of *this* realm's `Error`, and falling through to
 * the generic branch would render it `{}` — losing the message and the stack at
 * the one moment they matter.
 */
function isError(value: unknown): value is object {
	try {
		if (value instanceof Error) return true;
		return (
			typeof value === 'object' &&
			value !== null &&
			Object.prototype.toString.call(value) === '[object Error]'
		);
	} catch {
		return false;
	}
}

/**
 * `exception.type` is the field a dashboard groups failures by, so
 * `class ChargeRefused extends Error {}` must not read as `Error` — and it
 * would, because `name` is inherited unless the subclass assigns it. The class
 * name is what `stx-telemetry` records, and the two estates have to agree.
 */
function errorType(failure: object): string {
	const name = read(failure, 'name');
	const named = typeof name === 'string' && name ? name : undefined;
	if (named !== undefined && named !== 'Error') return named;

	const constructed = constructorName(failure);
	if (constructed !== undefined && constructed !== 'Object') return constructed;

	return named ?? 'Error';
}

function typeName(failure: unknown): string {
	if (failure === null) return 'null';
	if (typeof failure !== 'object') return typeof failure;
	return constructorName(failure) ?? 'Object';
}

function constructorName(value: object): string | undefined {
	const name = read(value, 'constructor');
	if (typeof name !== 'function' && typeof name !== 'object') return undefined;
	if (name === null) return undefined;

	const own = read(name, 'name');
	return typeof own === 'string' && own ? own : undefined;
}

function read(value: object, key: string): unknown {
	try {
		return (value as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}

function describe(failure: unknown): string {
	try {
		return typeof failure === 'object' && failure !== null
			? JSON.stringify(failure) || String(failure)
			: String(failure);
	} catch {
		return UNREADABLE;
	}
}
