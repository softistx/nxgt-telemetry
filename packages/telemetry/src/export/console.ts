import type { Attributes, AttributeValue } from '../attributes/attributes';
import type {
	ErrorInfo,
	LogRecord,
	Resource,
	Signal,
	SpanRecord,
} from '../model/signal';
import type { Exporter } from './exporter';

export interface ConsoleExporterOptions {
	/** Where a line goes. Default: `console.log`. */
	readonly write?: (line: string) => void;
	/** Whether a recorded stack is printed under the line. Default true. */
	readonly stackTraces?: boolean;
}

/**
 * One line per signal, for a terminal.
 *
 * ```
 * 10:04:22.318 INFO  CheckoutService  checkout.charged  orderId=o-1 amount=4200  [4bf92f35/00f067aa]
 * 10:04:22.402 SPAN  charge  84ms  [4bf92f35/00f067aa]
 * ```
 *
 * Errors go to the same stream as everything else: a log split across two
 * streams is a log read in the wrong order.
 */
export function consoleExporter(
	options: ConsoleExporterOptions = {},
): Exporter {
	const write = options.write ?? ((line: string) => console.log(line));
	const stackTraces = options.stackTraces ?? true;

	return {
		export(_resource: Resource, batch: readonly Signal[]): void {
			for (const signal of batch) {
				write(signal.type === 'log' ? renderLog(signal) : renderSpan(signal));

				const error = signal.error;
				if (stackTraces && error?.stackTrace) write(error.stackTrace);
			}
		},
	};
}

function renderLog(log: LogRecord): string {
	return [
		clock(log.at),
		log.severity.toUpperCase().padEnd(5),
		log.source,
		log.name,
		renderAttributes(log.attributes),
		renderError(log.error),
		renderTrace(log),
	]
		.filter(Boolean)
		.join('  ');
}

function renderSpan(span: SpanRecord): string {
	return [
		clock(span.endedAt),
		'SPAN ',
		span.name,
		`${span.endedAt - span.startedAt}ms`,
		span.status === 'ok' ? '' : span.status.toUpperCase(),
		renderAttributes(span.attributes),
		renderError(span.error),
		renderTrace(span),
	]
		.filter(Boolean)
		.join('  ');
}

function clock(at: number): string {
	// `toISOString` throws on an instant outside the range a Date can hold, and
	// a throw here would cost every signal after it in the batch. Nothing in
	// this library refuses a value.
	if (!Number.isFinite(at) || Math.abs(at) > 8.64e15) return String(at);
	return new Date(at).toISOString().slice(11, 23);
}

function renderAttributes(attributes: Attributes): string {
	return Object.entries(attributes)
		.map(([key, value]) => `${key}=${renderValue(value)}`)
		.join(' ');
}

function renderValue(value: AttributeValue): string {
	return Array.isArray(value) ? `[${value.join(',')}]` : String(value);
}

function renderError(error: ErrorInfo | undefined): string {
	if (error === undefined) return '';
	return error.message ? `${error.type}: ${error.message}` : error.type;
}

function renderTrace(signal: Signal): string {
	const span = signal.type === 'log' ? signal.span : signal.context;
	if (span === undefined) return '';
	return `[${span.traceId.slice(0, 8)}/${span.spanId.slice(0, 8)}]`;
}
