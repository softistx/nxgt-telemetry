import { currentAttributes, currentSpan } from '@nxgt/telemetry';

/**
 * What winston hands a format, and what a format hands back.
 *
 * Declared here rather than imported from `logform`, because the whole point of
 * this package is that it works with winston installed and does not require it
 * at build time. It is the shape winston actually passes: a mutable object with
 * `level` and `message`, and whatever else the caller put in it.
 */
export interface LogInfo {
	level: string;
	// biome-ignore lint/suspicious/noExplicitAny: logform's own `message` is `any`, and a narrower one here would not be assignable to it
	message: any;
	/**
	 * Symbols too, because winston keeps two of its own there — `Symbol.for('level')`
	 * for the level before any format coloured it, and `Symbol.for('message')` for
	 * the rendered line. A string-only index signature is not assignable to
	 * logform's `TransformableInfo`, which is what `combine` takes.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: as above, to stay assignable to logform's shape
	[field: string | symbol]: any;
}

/**
 * A winston format, as winston consumes one: an object with `transform`.
 *
 * `combine(...)` calls `format.transform(info, format.options)` and nothing
 * else, so this is the whole contract. Not importing `winston.format` is what
 * keeps this package installable in a service that has winston in one workspace
 * and not in another.
 */
export interface TelemetryFormat {
	readonly options: Record<string, unknown>;
	transform(info: LogInfo): LogInfo;
}

export interface FormatOptions {
	/** Default `traceId`. */
	readonly traceField?: string;
	/** Default `spanId`. */
	readonly spanField?: string;
	/**
	 * Whether the attributes in scope — what `span()` and `withAttributes()`
	 * were given — are copied onto the line too. Default `true`.
	 */
	readonly attributes?: boolean;
}

/**
 * Puts the current `traceId` and `spanId` on every line winston writes.
 *
 * ```ts
 * winston.createLogger({
 *   format: winston.format.combine(telemetryFormat(), winston.format.json()),
 * });
 * ```
 *
 * This is the half of the bridge that costs nothing to adopt: an application
 * keeps the logger it has, the lines keep the shape they have, and every one of
 * them gains the id that ties it to a trace. Put it **before** the format that
 * renders the line — `json()`, `printf()`, `simple()` — or the fields will be
 * added to something already turned into a string.
 *
 * Outside any span it adds nothing, rather than a null or an empty string: a
 * field that is present and empty is one a dashboard has to filter out.
 */
export function telemetryFormat(options: FormatOptions = {}): TelemetryFormat {
	const traceField = options.traceField ?? 'traceId';
	const spanField = options.spanField ?? 'spanId';
	const withAttributes = options.attributes ?? true;

	return {
		options: {},
		transform(info: LogInfo): LogInfo {
			// A format runs on the way to every transport, on every line. It
			// cannot be the reason a line is lost, so nothing in here throws.
			try {
				if (withAttributes) stamp(info, currentAttributes());

				const span = currentSpan();
				if (span === undefined) return info;

				info[traceField] = span.traceId;
				info[spanField] = span.spanId;
			} catch {
				// A caller's own field stays whatever it already was.
			}
			return info;
		},
	};
}

/**
 * The attributes in scope, but never over a field the caller set.
 *
 * A line that says `orderId: 'o-1'` means that order, and an ambient attribute
 * of the same name replacing it would be a lie told quietly.
 */
function stamp(info: LogInfo, attributes: Record<string, unknown>): void {
	for (const [name, value] of Object.entries(attributes)) {
		if (!(name in info)) info[name] = value;
	}
}
