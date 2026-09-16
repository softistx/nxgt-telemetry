import type {
	Exporter,
	LogRecord,
	Resource,
	Severity,
	Signal,
	SpanRecord,
} from '@nxgt/telemetry';
import { levelOf } from '../bridge/levels';
import { FROM_TELEMETRY } from '../bridge/origin';
import { TelemetryTransport } from '../bridge/transport';

/**
 * What this exporter needs of a logger.
 *
 * Structural, so that `winston.Logger`, a child logger, and
 * `@nxgt/shared-logging`'s `Logger` — which *is* winston's — all fit without
 * this package importing any of them.
 */
export interface WinstonLike {
	log(level: string, message: string, meta?: Record<string, unknown>): unknown;
	readonly transports?: readonly unknown[];
}

export interface WinstonExporterOptions {
	/** The logger the signals are written to. */
	readonly logger: WinstonLike;
	/** Whether spans are written as lines too. Default `false`. */
	readonly spans?: boolean;
	/** The level a span is written at. Default `info`. */
	readonly spanSeverity?: Severity;
}

/**
 * Telemetry signals into a winston logger that is already there.
 *
 * ```ts
 * createTelemetry('checkout', {
 *   exporters: [winstonExporter({ logger })],
 * }).install();
 * ```
 *
 * For an application whose log shipping is solved — a file rotation, a syslog
 * transport, a vendor's — and that wants `log.info(...)` from this library to
 * land in the same place as everything else, rather than a second pipe to
 * operate.
 *
 * Spans are **off** by default. A span is a duration and a set of attributes,
 * which is a poor fit for a line of text, and turning every one of them into a
 * log line is how a cheap trace becomes an expensive log bill. `spans: true`
 * when the lines are what you have.
 *
 * A **failed span is always written at `error`**, whatever `spanSeverity` says.
 * That is the line somebody is looking for.
 */
export function winstonExporter(options: WinstonExporterOptions): Exporter {
	refuseTheLoop(options.logger);

	const spans = options.spans ?? false;
	const spanSeverity = options.spanSeverity ?? 'info';

	return {
		export(_resource: Resource, batch: readonly Signal[]): void {
			for (const signal of batch) {
				if (signal.type === 'log') {
					write(
						options.logger,
						levelOf(signal.severity),
						signal.name,
						meta(signal),
					);
					continue;
				}
				if (!spans) continue;

				const severity = signal.status === 'error' ? 'error' : spanSeverity;
				write(options.logger, levelOf(severity), signal.name, spanMeta(signal));
			}
		},
	};
}

/**
 * A logger that already feeds the pipeline must not also be fed by it.
 *
 * Caught at construction, because the failure mode is a loop that does not
 * crash: it spins, and the first sign of it is a machine at 100% writing the
 * same line to itself. A message at startup is the cheapest possible version of
 * that discovery.
 */
function refuseTheLoop(logger: WinstonLike): void {
	const found = logger.transports?.some(
		(transport) => transport instanceof TelemetryTransport,
	);
	if (found !== true) return;

	throw new Error(
		'[telemetry] this logger already has a telemetryTransport(), so exporting ' +
			'to it would be a loop: its lines go to the pipeline, and the pipeline ' +
			'would write them back to it. Use one direction or the other — the ' +
			'transport to collect winston lines, or winstonExporter to write ' +
			'signals — not both on the same logger.',
	);
}

function write(
	logger: WinstonLike,
	level: string,
	message: string,
	meta: Record<string, unknown>,
): void {
	try {
		logger.log(level, message, meta);
	} catch {
		// An exporter that throws reaches `onExportError` and costs the rest of
		// the batch. A logger with a broken transport is not worth that.
	}
}

function meta(signal: LogRecord): Record<string, unknown> {
	return {
		...signal.attributes,
		[FROM_TELEMETRY]: true,
		source: signal.source,
		...(signal.span === undefined
			? {}
			: { traceId: signal.span.traceId, spanId: signal.span.spanId }),
	};
}

function spanMeta(signal: SpanRecord): Record<string, unknown> {
	return {
		...signal.attributes,
		[FROM_TELEMETRY]: true,
		kind: signal.kind,
		status: signal.status,
		durationMs: signal.endedAt - signal.startedAt,
		traceId: signal.context.traceId,
		spanId: signal.context.spanId,
		...(signal.parent === undefined ? {} : { parentSpanId: signal.parent }),
		...(signal.error === undefined
			? {}
			: {
					'exception.type': signal.error.type,
					...(signal.error.message === undefined
						? {}
						: { 'exception.message': signal.error.message }),
				}),
	};
}
