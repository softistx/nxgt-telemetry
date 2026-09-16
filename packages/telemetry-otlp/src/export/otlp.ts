import type { Exporter, Resource, Signal } from '@nxgt/telemetry';
import { logsRequest, tracesRequest } from '../wire/convert';
import {
	DEFAULT_ATTEMPTS,
	DEFAULT_BACKOFF,
	DEFAULT_TIMEOUT,
	type PartialSuccessReport,
	post,
	type Transport,
	wait,
} from './transport';

export const DEFAULT_LOGS_PATH = '/v1/logs';
export const DEFAULT_TRACES_PATH = '/v1/traces';

export interface OtlpExporterOptions {
	/** The collector's base URL, e.g. `http://localhost:4318`. */
	readonly endpoint: string;
	/** Appended to `endpoint`. Default `/v1/logs`. */
	readonly logsPath?: string;
	/** Appended to `endpoint`. Default `/v1/traces`. */
	readonly tracesPath?: string;
	/** Sent on every request — an API key, a tenant. */
	readonly headers?: Readonly<Record<string, string>>;
	/** Per attempt, in milliseconds. Default 10s. */
	readonly timeout?: number;
	/** How many requests one document gets. Default 3. `1` disables retrying. */
	readonly attempts?: number;
	/** The first wait between attempts, doubled each time. Default 500ms. */
	readonly backoff?: number;
	/** Gzip a document over 1 KiB. Default true. */
	readonly gzip?: boolean;
	/** Called when the collector accepted the request but not every record. */
	readonly onPartialSuccess?: (report: PartialSuccessReport) => void;
	/** For specs, and for an application that routes its own traffic. */
	readonly fetch?: typeof fetch;
	/** For specs. Default a `setTimeout` that does not hold the process open. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Logs and traces to an OpenTelemetry collector, as OTLP/HTTP JSON.
 *
 * ```ts
 * otlpExporter({ endpoint: 'http://localhost:4318', headers: { 'x-api-key': key } })
 * ```
 *
 * There is no OpenTelemetry SDK behind this. OTLP is a wire format, and the
 * whole of it that a collector needs is two JSON documents over `fetch` — which
 * is what lets this package have one dependency and no transitive tree, and
 * what keeps the context in `AsyncLocalStorage` instead of in the Java SDK's
 * thread-local shape.
 *
 * A mixed batch is **two requests**, one per document, sent together: logs
 * failing must not cost the traces of the same batch. Both are attempted, and
 * both failures are thrown — as an `AggregateError` when there are two —
 * which means they reach `onExportError` and nothing else.
 */
export function otlpExporter(options: OtlpExporterOptions): Exporter {
	const endpoint = options.endpoint.replace(/\/+$/, '');
	const logsUrl = endpoint + (options.logsPath ?? DEFAULT_LOGS_PATH);
	const tracesUrl = endpoint + (options.tracesPath ?? DEFAULT_TRACES_PATH);

	const transport: Transport = {
		headers: options.headers ?? {},
		timeout: options.timeout ?? DEFAULT_TIMEOUT,
		attempts: Math.max(options.attempts ?? DEFAULT_ATTEMPTS, 1),
		backoff: options.backoff ?? DEFAULT_BACKOFF,
		gzip: options.gzip ?? true,
		...(options.onPartialSuccess === undefined
			? {}
			: { onPartialSuccess: options.onPartialSuccess }),
		fetch: options.fetch ?? fetch,
		sleep: options.sleep ?? wait,
	};

	return {
		async export(resource: Resource, batch: readonly Signal[]): Promise<void> {
			const logs = logsRequest(resource, batch);
			const traces = tracesRequest(resource, batch);

			const sent = await Promise.allSettled([
				logs === undefined ? undefined : post(transport, logsUrl, 'logs', logs),
				traces === undefined
					? undefined
					: post(transport, tracesUrl, 'traces', traces),
			]);

			throwAll(sent);
		},
	};
}

/**
 * The two documents go to two paths and can fail for unrelated reasons — a
 * `400` on one and a refused connection on the other is not one outage. Losing
 * the second is losing the half of the story that says the collector is not
 * simply down, so both are reported.
 */
function throwAll(sent: readonly PromiseSettledResult<unknown>[]): void {
	const failures = sent
		.filter((one) => one.status === 'rejected')
		.map((one) => one.reason as unknown);

	if (failures.length === 0) return;
	if (failures.length === 1) throw failures[0];

	throw new AggregateError(
		failures,
		'[telemetry] neither the logs nor the traces of this batch arrived',
	);
}
