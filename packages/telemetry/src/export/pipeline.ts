import type { Resource, Signal } from '../model/signal';
import type { Exporter } from './exporter';

export interface PipelineOptions {
	readonly resource: Resource;
	readonly exporters: readonly Exporter[];
	/** Flush once this many signals are waiting. */
	readonly batch: number;
	/** Flush this many milliseconds after the first signal of a batch. */
	readonly linger: number;
	/** How long `close` waits for the backlog before giving up. */
	readonly drainTimeout: number;
	readonly onExportError: (failure: unknown) => void;
}

/**
 * The queue between everything that writes a signal and everything that ships
 * one.
 *
 * `post` is synchronous, total, and unbounded. A bounded queue would answer the
 * back-pressure question by dropping signals or by blocking the application,
 * and neither is an answer; an application that outruns its collector grows
 * this array, which is visible in a heap profile, rather than losing the
 * evidence of what it was doing.
 *
 * One consumer drains it, which is what lets the buffer be a plain array with
 * no locking and what makes a batch's order the order things happened in.
 */
export class Pipeline {
	private readonly options: PipelineOptions;
	private buffer: Signal[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** The single consumer: every flush is chained onto the previous one. */
	private draining: Promise<void> = Promise.resolve();
	private closed = false;
	private closing: Promise<void> | undefined;

	constructor(options: PipelineOptions) {
		this.options = options;
	}

	/**
	 * Never blocks, never throws, and answers whether the signal was taken.
	 * `false` means the pipeline is closed — the signal is dropped in silence,
	 * because a log must not become the reason a shutdown fails.
	 */
	post(signal: Signal): boolean {
		if (this.closed) return false;

		this.buffer.push(signal);

		if (this.buffer.length >= this.options.batch) {
			this.flush();
		} else if (this.timer === undefined) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.flush();
			}, this.options.linger);
			// A telemetry that is merely idle must not be the reason a process
			// will not exit.
			this.timer.unref?.();
		}

		return true;
	}

	/**
	 * Stops accepting signals, ships what is waiting, and closes every
	 * exporter. Idempotent.
	 *
	 * It has to be awaited, and it is the one thing here that a caller waits
	 * for: a close that returned before the backlog shipped would lose exactly
	 * the signals a shutdown most needs to explain itself. `drainTimeout`
	 * bounds it, so a collector that stopped answering does not become the
	 * reason a process will not exit.
	 */
	close(): Promise<void> {
		this.closing ??= this.drainAndClose();
		return this.closing;
	}

	private flush(): void {
		if (this.buffer.length === 0) return;

		const batch = this.buffer;
		this.buffer = [];

		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}

		this.draining = this.draining.then(() => this.ship(batch));
	}

	private async ship(batch: readonly Signal[]): Promise<void> {
		for (const exporter of this.options.exporters) {
			try {
				await exporter.export(this.options.resource, batch);
			} catch (failure) {
				this.report(failure);
			}
		}
	}

	private async drainAndClose(): Promise<void> {
		this.closed = true;
		this.flush();

		await Promise.race([this.draining, timeout(this.options.drainTimeout)]);

		for (const exporter of this.options.exporters) {
			try {
				await exporter.close?.();
			} catch (failure) {
				this.report(failure);
			}
		}
	}

	private report(failure: unknown): void {
		try {
			this.options.onExportError(failure);
		} catch {
			// A failing error handler is not worth a second failure. It is the
			// last place a signal could be lost, and losing it here is the
			// point: there is nowhere else to report to.
		}
	}
}

function timeout(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		timer.unref?.();
	});
}
