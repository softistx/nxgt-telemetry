import { Writable } from 'node:stream';
import {
	type Attributes,
	attributesOf,
	currentAttributes,
	currentSpan,
	type ErrorInfo,
	errorInfo,
	type LogRecord,
	meetsSeverity,
	mergeAttributes,
	resolveTelemetry,
	type Severity,
	type Telemetry,
} from '@nxgt/telemetry';
import type { LogInfo } from './format';
import { severityOf } from './levels';
import { FROM_TELEMETRY } from './origin';

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
const LEVEL = Symbol.for('level');

/** What a logger looks like from inside the transport it pipes into. */
interface WinstonSource {
	readonly level?: string;
	readonly levels?: Readonly<Record<string, number>>;
}

export interface TransportOptions {
	/** The source every line is attributed to. Default `winston`. */
	readonly source?: string;
	/**
	 * The telemetry to write to. Default: the one in scope when the line is
	 * written, and the installed one otherwise.
	 */
	readonly telemetry?: Telemetry;
	/** What a level this library does not know becomes. Default `info`. */
	readonly fallback?: Severity;
	/** winston's own option: the lowest level this transport receives. */
	readonly level?: string;
	/** winston's own option: a transport that is silent receives nothing. */
	readonly silent?: boolean;
	/**
	 * Whether a line winston's `exceptionHandlers` produced is collected too.
	 * Default `false`, which is winston's own default for a transport.
	 *
	 * It is off for a reason worth knowing. Turning it on puts this transport in
	 * winston's list of exception handlers, and winston then waits for each of
	 * them to emit `finish` before letting the process exit — up to three
	 * seconds. A `process.on('uncaughtException')` that calls `log.error` and
	 * awaits `telemetry.close()` is the direct route, and costs no exit delay.
	 */
	readonly handleExceptions?: boolean;
}

/**
 * A winston transport that writes every line into the telemetry pipeline.
 *
 * ```ts
 * logger.add(telemetryTransport());
 * ```
 *
 * The other half of the bridge, for an application that already logs through
 * winston and wants those lines exported the way its spans are — to OTLP, to
 * Mongo, to a file — without rewriting a single call site.
 *
 * It extends `node:stream`'s `Writable` rather than `winston-transport`, which
 * is the same thing winston-transport does and means **this package has no
 * runtime dependency**: it is installable in a workspace that does not have
 * winston at all. What winston requires of a transport is a writable stream in
 * object mode with a `log(info, next)` of arity two, and that is what this is.
 */
export class TelemetryTransport extends Writable {
	readonly source: string;
	readonly level: string | undefined;
	/** Set by winston when this is piped to a logger, and used to honour `level`. */
	levels: Readonly<Record<string, number>> | undefined;
	/** The logger this is attached to, which is where a default level comes from. */
	parent: { readonly level?: string } | undefined;
	silent: boolean;
	readonly handleExceptions: boolean;
	private readonly telemetry: Telemetry | undefined;
	private readonly fallback: Severity;

	constructor(options: TransportOptions = {}) {
		super({ objectMode: true });
		this.source = options.source ?? 'winston';
		this.level = options.level;
		this.silent = options.silent ?? false;
		this.handleExceptions = options.handleExceptions ?? false;
		this.telemetry = options.telemetry;
		this.fallback = options.fallback ?? 'info';

		// How winston-transport learns its logger, and the only way to: a
		// logger pipes itself into its transports, and Node's `Writable` emits
		// `pipe` with the source. Without this, `level` on a transport would be
		// a field nothing reads — winston does the filtering *in the transport*,
		// not before it.
		this.once('pipe', (logger: WinstonSource) => {
			this.levels ??= logger.levels;
			this.parent ??= logger;
		});
		// `logger.remove(transport)` unpipes. Left pointing at the old logger,
		// `parent` would keep filtering by a level that is no longer anybody's.
		this.on('unpipe', () => {
			this.parent = undefined;
		});
	}

	/**
	 * Arity two, which is what winston checks to decide this is a modern
	 * transport rather than a legacy one it has to wrap.
	 */
	log(info: LogInfo, next: () => void): void {
		try {
			this.post(info);
		} catch {
			// A transport that throws takes down the line for every *other*
			// transport too. Writing a log must not be able to fail.
		}
		next();
	}

	override _write(
		info: LogInfo,
		_encoding: BufferEncoding,
		next: (error?: Error | null) => void,
	): void {
		if (this.silent || !this.wanted(info)) {
			next();
			return;
		}
		if (info.exception === true && !this.handleExceptions) {
			next();
			return;
		}
		this.log(info, () => next());
	}

	/**
	 * The level filter, the way winston-transport applies it.
	 *
	 * The level to compare against is the transport's own, falling back to the
	 * logger's, and the comparison is on winston's *numbers* — where a lower
	 * number is more severe. `info[Symbol.for('level')]` is the line's level
	 * before any format coloured it, which is why it is read rather than
	 * `info.level`.
	 */
	private wanted(info: LogInfo): boolean {
		// `||` rather than `??`, which is winston's own: a transport with
		// `level: ''` falls back to the logger's there, and must here too.
		const level = this.level || this.parent?.level;
		if (!level || this.levels === undefined) return true;

		const wrote = this.levels[String(info[LEVEL] ?? info.level)];
		const floor = this.levels[level];
		// **Deliberately not winston's answer here.** `winston-transport` compares
		// against `undefined`, which is `false`, so a line at a level the table
		// does not know is dropped. This keeps it: a level nobody declared is
		// somebody's mistake, and losing the line is how the mistake stays
		// invisible. Everything else in this method is winston's rule exactly.
		if (wrote === undefined || floor === undefined) return true;

		return floor >= wrote;
	}

	private post(info: LogInfo): void {
		// A line this library wrote into winston, coming back round. Posting it
		// would be an infinite loop that looks like a busy service.
		if (info[FROM_TELEMETRY] === true) return;

		const telemetry = this.telemetry ?? resolveTelemetry();
		if (telemetry === undefined) return;

		const severity = severityOf(info.level, this.fallback);
		// The pipeline's floor, the same one `log.*` clears. winston has already
		// applied its own; this is the telemetry's, and a service that set
		// `minimum: 'error'` means it for every route into the pipeline.
		if (!meetsSeverity(severity, telemetry.minimum)) return;

		telemetry.emit(this.record(info, severity, telemetry.stackTraces));
	}

	private record(
		info: LogInfo,
		severity: Severity,
		stackTraces: boolean,
	): LogRecord {
		const span = currentSpan();
		const failure = failureOf(info, stackTraces);

		return {
			type: 'log',
			at: Date.now(),
			severity,
			name: message(info),
			source: this.source,
			// The attributes in scope, under the line's own — which is the
			// inheritance rule everywhere else in this library, and a field the
			// call site set must still win.
			attributes: mergeAttributes(currentAttributes(), rest(info)),
			...(span === undefined ? {} : { span }),
			...(failure === undefined ? {} : { error: failure }),
		};
	}
}

/**
 * A winston transport, as an instance.
 *
 * `telemetryTransport()` reads better at a call site than `new
 * TelemetryTransport()`, and matches how every other integration here is built.
 */
export function telemetryTransport(
	options: TransportOptions = {},
): TelemetryTransport {
	return new TelemetryTransport(options);
}

/**
 * The line's text.
 *
 * winston's `message` is whatever was passed — a string, an object, an `Error`.
 * `attributesOf` would render an object to a string eventually, but the name of
 * a log record is the thing a human reads first, so it is worth one explicit
 * pass.
 */
function message(info: LogInfo): string {
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
function failureOf(info: LogInfo, stackTraces: boolean): ErrorInfo | undefined {
	if (info.message instanceof Error)
		return errorInfo(info.message, stackTraces);
	if (info.error instanceof Error) return errorInfo(info.error, stackTraces);
	if (typeof info.stack !== 'string' || info.stack === '') return undefined;

	// `format.errors()` flattens the error onto the line and keeps only the
	// stack, so this is what is left to rebuild from.
	const rebuilt: ErrorInfo = {
		type: typeOf(info.stack),
		message: message(info),
	};
	// Named rather than spread: a spread into an object literal turns off the
	// excess-property check, which is what would let a misspelled field through
	// — and `stackTrace` is easy to write as `stack`, which is what winston
	// calls it.
	return stackTraces ? { ...rebuilt, stackTrace: info.stack } : rebuilt;
}

/** `TypeError: bad` is a `TypeError`; anything unrecognisable is an `Error`. */
function typeOf(stack: string): string {
	const named = /^([A-Za-z_$][\w$]*(?:Error|Exception))\b/.exec(stack);
	return named?.[1] ?? 'Error';
}

/** Everything the caller added, through the coercion that never refuses. */
function rest(info: LogInfo): Attributes {
	const carried: Record<string, unknown> = {};

	for (const [name, value] of Object.entries(info)) {
		if (!OWN.has(name)) carried[name] = value;
	}

	return attributesOf(carried);
}
