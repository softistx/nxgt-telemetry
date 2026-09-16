import { Writable } from 'node:stream';
import {
	type Attributes,
	attributesOf,
	currentSpan,
	type LogRecord,
	resolveTelemetry,
	type Severity,
	type Telemetry,
} from '@nxgt/telemetry';
import type { LogInfo } from './format';
import { severityOf } from './levels';
import { FROM_TELEMETRY } from './origin';

/** winston's own two fields, which become the record rather than attributes. */
const OWN: ReadonlySet<string> = new Set(['level', 'message']);

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
	silent = false;
	private readonly telemetry: Telemetry | undefined;
	private readonly fallback: Severity;

	constructor(options: TransportOptions = {}) {
		super({ objectMode: true });
		this.source = options.source ?? 'winston';
		this.level = options.level;
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
		const level = this.level ?? this.parent?.level;
		if (level === undefined || this.levels === undefined) return true;

		const wrote = this.levels[String(info[LEVEL] ?? info.level)];
		const floor = this.levels[level];
		if (wrote === undefined || floor === undefined) return true;

		return floor >= wrote;
	}

	private post(info: LogInfo): void {
		// A line this library wrote into winston, coming back round. Posting it
		// would be an infinite loop that looks like a busy service.
		if (info[FROM_TELEMETRY] === true) return;

		const telemetry = this.telemetry ?? resolveTelemetry();
		if (telemetry === undefined) return;

		telemetry.emit(this.record(info));
	}

	private record(info: LogInfo): LogRecord {
		const span = currentSpan();

		return {
			type: 'log',
			at: Date.now(),
			severity: severityOf(info.level, this.fallback),
			name: message(info),
			source: this.source,
			attributes: rest(info),
			...(span === undefined ? {} : { span }),
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

/** Everything the caller added, through the coercion that never refuses. */
function rest(info: LogInfo): Attributes {
	const carried: Record<string, unknown> = {};

	for (const [name, value] of Object.entries(info)) {
		if (!OWN.has(name)) carried[name] = value;
	}

	return attributesOf(carried);
}
