import {
	type Attributes,
	attributesOf,
	EMPTY_ATTRIBUTES,
	mergeAttributes,
} from '../attributes/attributes';
import {
	currentAttributes,
	currentSpan,
	resolveTelemetry,
} from '../context/current';
import { errorInfo } from '../model/error';
import { type LogRecord, meetsSeverity, type Severity } from '../model/signal';
import { isTelemetryEvent, type TelemetryEvent } from './event';

type Fields = Readonly<Record<string, unknown>>;

/** A message, a declared event, or a message that is only built if it is wanted. */
export type LogInput = string | TelemetryEvent | (() => string);

/** A message or a declared event. The lazy form is for `debug` and `info` only. */
export type Reported = string | TelemetryEvent;

/**
 * Writing a log never waits and never fails.
 *
 * Every method here is synchronous and total. With no telemetry installed the
 * line is dropped in silence — a library that logs must work inside an
 * application that has never heard of this one. Below the severity floor
 * nothing is built at all, which is what makes the lazy form worth having.
 */
export interface Logger {
	/** Whether anything would come of a log at this level, right here. */
	enabled(severity: Severity): boolean;

	debug(input: LogInput, attributes?: Fields): void;
	info(input: LogInput, attributes?: Fields): void;

	warn(input: Reported, attributes?: Fields): void;
	warn(input: Reported, failure: unknown, attributes?: Fields): void;

	error(input: Reported, attributes?: Fields): void;
	error(input: Reported, failure: unknown, attributes?: Fields): void;
}

/**
 * ```ts
 * const log = createLogger('CheckoutService');
 *
 * log.info(Charged({ orderId, amount }));          // a declared event
 * log.warn('charge refused', { orderId, code });   // ad hoc, for what has no type yet
 * log.debug(() => `state: ${expensive()}`);        // built only if debug is on
 * log.error('charge failed', failure, { orderId });
 * ```
 *
 * `source` is the logger's name — a class, a module, whatever groups these
 * lines. It becomes the instrumentation scope an OTLP backend shows.
 *
 * The telemetry is resolved **at each call**, scope first and installed second.
 * That is what lets two suites in one process each collect their own signals,
 * and it is why a logger can be built at module scope before anything is
 * installed.
 */
export function createLogger(source: string): Logger {
	const write = (
		severity: Severity,
		input: LogInput,
		second?: unknown,
		third?: Fields,
	): void => {
		const telemetry = resolveTelemetry();
		if (telemetry === undefined) return;
		if (!meetsSeverity(severity, telemetry.minimum)) return;

		const [failure, fields] = split(second, third);
		const span = currentSpan();
		const named = name(input);

		const record: LogRecord = {
			type: 'log',
			at: Date.now(),
			severity,
			name: named.name,
			source,
			attributes: mergeAttributes(
				mergeAttributes(currentAttributes(), named.attributes),
				attributesOf(fields),
			),
			...(span === undefined ? {} : { span }),
			...(failure === undefined
				? {}
				: { error: errorInfo(failure, telemetry.stackTraces) }),
		};

		telemetry.emit(record);
	};

	return {
		enabled(severity: Severity): boolean {
			const telemetry = resolveTelemetry();
			return (
				telemetry !== undefined && meetsSeverity(severity, telemetry.minimum)
			);
		},
		debug: (input, attributes) => write('debug', input, attributes),
		info: (input, attributes) => write('info', input, attributes),
		warn: (input, second?: unknown, third?: Fields) =>
			write('warn', input, second, third),
		error: (input, second?: unknown, third?: Fields) =>
			write('error', input, second, third),
	};
}

/**
 * `warn(message, attributes)` and `warn(message, failure, attributes)` are the
 * same call at runtime. A plain record is attributes; anything else — an
 * `Error`, a string, a rejected value — is the failure, because nobody passes
 * one of those as a bag of fields.
 */
function split(
	second: unknown,
	third: Fields | undefined,
): [failure: unknown, fields: Fields | undefined] {
	if (third !== undefined) return [second, third];
	if (second === undefined) return [undefined, undefined];
	return isFields(second) ? [undefined, second] : [second, undefined];
}

function isFields(value: unknown): value is Fields {
	if (typeof value !== 'object' || value === null) return false;

	try {
		if (value instanceof Error || Array.isArray(value)) return false;

		const prototype = Object.getPrototypeOf(value);
		if (prototype === null || prototype === Object.prototype) return true;

		// Another realm's `Object.prototype` is not ours, but it is still the
		// root of its own chain and its constructor is still called `Object`.
		// Without this a plain object from a worker reads as a failure, and its
		// fields stop being indexable.
		return (
			Object.getPrototypeOf(prototype) === null &&
			(prototype as { constructor?: { name?: unknown } }).constructor?.name ===
				'Object'
		);
	} catch {
		// A `getPrototypeOf` trap that throws, or a revoked Proxy. Reading it as
		// a failure is the safe answer: it is recorded either way, and nothing
		// here is allowed to raise.
		return false;
	}
}

/**
 * The line's name and the attributes its type declared. A lazy message that
 * throws still logs: whatever went wrong building the text, the fact that
 * something happened here is the part worth keeping.
 */
function name(input: LogInput): { name: string; attributes: Attributes } {
	if (typeof input === 'string') {
		return { name: input, attributes: EMPTY_ATTRIBUTES };
	}

	if (isTelemetryEvent(input)) {
		return { name: input.name, attributes: input.attributes };
	}

	try {
		return { name: input(), attributes: EMPTY_ATTRIBUTES };
	} catch (failure) {
		return {
			name: '[message failed to build]',
			attributes: {
				'telemetry.message.invalid': errorInfo(failure, false).type,
			},
		};
	}
}
