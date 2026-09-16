import { attributesOf } from '../attributes/attributes';
import type { Exporter } from '../export/exporter';
import { Pipeline } from '../export/pipeline';
import type { Resource, Severity, Signal } from '../model/signal';
import { alwaysSample, type Sampler } from '../trace/sampler';

export interface TelemetryOptions {
	readonly version?: string;
	readonly environment?: string;
	/** Stamped on the resource, so every signal carries them. */
	readonly attributes?: Readonly<Record<string, unknown>>;
	/** Asked once, for a root span. Default: `alwaysSample`. */
	readonly sampler?: Sampler;
	/** Logs below this are never built. Spans are unaffected. Default `info`. */
	readonly minimum?: Severity;
	/** Whether a recorded failure carries its stack. Default true. */
	readonly stackTraces?: boolean;
	/** Flush once this many signals are waiting. Default 512. */
	readonly batch?: number;
	/** Flush this long after the first signal of a batch, in ms. Default 1000. */
	readonly linger?: number;
	/** How long `close` waits for the backlog, in ms. Default 10000. */
	readonly drainTimeout?: number;
	/** Default: `console.error`. It must not throw; if it does, it is ignored. */
	readonly onExportError?: (failure: unknown) => void;
	/** In order. A batch reaches them one after the other. */
	readonly exporters?: readonly Exporter[];
}

export const TELEMETRY_DEFAULTS = Object.freeze({
	minimum: 'info' as Severity,
	stackTraces: true,
	batch: 512,
	linger: 1_000,
	drainTimeout: 10_000,
});

let installed: Telemetry | undefined;

/**
 * A service's telemetry: its resource, its sampler, and the pipeline its
 * signals go through.
 *
 * Build it with {@link createTelemetry}. `install()` makes it the one a logger
 * or a span finds when there is none in scope.
 */
export class Telemetry {
	readonly resource: Resource;
	readonly sampler: Sampler;
	readonly minimum: Severity;
	readonly stackTraces: boolean;

	private readonly pipeline: Pipeline;

	constructor(options: TelemetryOptions & { readonly service: string }) {
		this.resource = {
			service: options.service,
			...(options.version === undefined ? {} : { version: options.version }),
			...(options.environment === undefined
				? {}
				: { environment: options.environment }),
			attributes: attributesOf(options.attributes),
		};
		this.sampler = options.sampler ?? alwaysSample;
		this.minimum = options.minimum ?? TELEMETRY_DEFAULTS.minimum;
		this.stackTraces = options.stackTraces ?? TELEMETRY_DEFAULTS.stackTraces;

		this.pipeline = new Pipeline({
			resource: this.resource,
			exporters: options.exporters ?? [],
			batch: options.batch ?? TELEMETRY_DEFAULTS.batch,
			linger: options.linger ?? TELEMETRY_DEFAULTS.linger,
			drainTimeout: options.drainTimeout ?? TELEMETRY_DEFAULTS.drainTimeout,
			onExportError: options.onExportError ?? defaultOnExportError,
		});
	}

	/** Never blocks, never throws. False once closed. */
	emit(signal: Signal): boolean {
		return this.pipeline.post(signal);
	}

	/** The one a logger or a span finds with nothing in scope. Returns itself. */
	install(): this {
		installed = this;
		return this;
	}

	/**
	 * Ships the backlog and closes the exporters. **It has to be awaited**:
	 * JavaScript cannot block, so a process that exits without waiting loses
	 * its last batch — which is the batch that explains the shutdown.
	 *
	 * Idempotent, and it stands down as the installed default.
	 */
	async close(): Promise<void> {
		if (installed === this) installed = undefined;
		await this.pipeline.close();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}

/**
 * ```ts
 * const telemetry = createTelemetry('checkout', {
 *   environment: 'production',
 *   sampler: ratioSampler(0.1),
 *   exporters: [consoleExporter()],
 * }).install();
 * ```
 *
 * `service` has no default on purpose: it is the key everything groups by, and
 * a service called `unknown` is a dashboard nobody can read.
 */
export function createTelemetry(
	service: string,
	options: TelemetryOptions = {},
): Telemetry {
	return new Telemetry({ ...options, service });
}

/** The installed default, if `install()` has been called. */
export function installedTelemetry(): Telemetry | undefined {
	return installed;
}

/**
 * Only for a test that needs the process back the way it found it. Production
 * code stands an instance down by closing it.
 */
export function uninstallTelemetry(telemetry?: Telemetry): void {
	if (telemetry === undefined || installed === telemetry) installed = undefined;
}

function defaultOnExportError(failure: unknown): void {
	console.error('[telemetry] export failed', failure);
}
