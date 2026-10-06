import {
	type Attributes,
	attributesOf,
	type ErrorInfo,
	errorInfo,
} from '@nxgt/telemetry';
import type { LogInfo } from './format';

/**
 * winston's own fields, which become the record rather than attributes.
 *
 * `stack` is here because `format.errors()` puts it on the line, and it belongs
 * in the record's `ErrorInfo` where an exporter knows what it is — as
 * `exception.stacktrace` on the wire — rather than as a free-text attribute
 * nothing queries. `exception` is winston's own flag for a line its
 * `exceptionHandlers` produced.
 */
const OWN: ReadonlySet<string> = new Set([
	'level',
	'message',
	'stack',
	'exception',
]);

/**
 * Where winston keeps the line's level *before* any format coloured it.
 *
 * `Symbol.for`, not a fresh symbol: it is the same registry entry `logform`
 * uses, and reading it is how every winston transport decides what to keep.
 */
export const LEVEL = Symbol.for('level');

/**
 * The line's text.
 *
 * winston's `message` is whatever was passed — a string, an object, an `Error`.
 * `attributesOf` would render an object to a string eventually, but the name of
 * a log record is the thing a human reads first, so it is worth one explicit
 * pass.
 */
export function message(info: LogInfo): string {
	const text = info.message;
	if (typeof text === 'string') return text;
	if (text instanceof Error) return text.message;
	if (text === undefined || text === null) return '';

	try {
		return typeof text === 'object' ? JSON.stringify(text) : String(text);
	} catch {
		// A circular object, or a getter that throws. The line still arrives.
		return String(text);
	}
}

/**
 * The failure a line is about, if it is about one.
 *
 * winston takes an `Error` three ways — as the message, as `error` in the meta,
 * and as a `stack` string that `format.errors()` left behind — and an exporter
 * needs it as an `ErrorInfo` or it is only text. Without this, an OTLP consumer
 * gets no `exception.type` for a line that was written with an exception in
 * hand, which is the one field an exception dashboard queries on.
 */
export function failureOf(
	info: LogInfo,
	stackTraces: boolean,
): ErrorInfo | undefined {
	if (info.message instanceof Error)
		return errorInfo(info.message, stackTraces);
	if (info['error'] instanceof Error)
		return errorInfo(info['error'], stackTraces);
	if (typeof info['stack'] !== 'string' || info['stack'] === '')
		return undefined;

	// `format.errors()` flattens the error onto the line and keeps only the
	// stack, so this is what is left to rebuild from.
	const rebuilt: ErrorInfo = {
		type: typeOf(info['stack']),
		message: message(info),
	};
	// Named rather than spread: a spread into an object literal turns off the
	// excess-property check, which is what would let a misspelled field through
	// — and `stackTrace` is easy to write as `stack`, which is what winston
	// calls it.
	return stackTraces ? { ...rebuilt, stackTrace: info['stack'] } : rebuilt;
}

/** `TypeError: bad` is a `TypeError`; anything unrecognisable is an `Error`. */
function typeOf(stack: string): string {
	const named = /^([A-Za-z_$][\w$]*(?:Error|Exception))\b/.exec(stack);
	return named?.[1] ?? 'Error';
}

/** Everything the caller added, through the coercion that never refuses. */
export function rest(info: LogInfo): Attributes {
	const carried: Record<string, unknown> = {};

	for (const [name, value] of Object.entries(info)) {
		if (!OWN.has(name)) carried[name] = value;
	}

	return attributesOf(carried);
}
