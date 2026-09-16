import type { Resource, Signal } from '../model/signal';

/**
 * Where a batch of signals goes.
 *
 * The contract, which the pipeline guarantees and an implementation may rely
 * on:
 *
 * - **`export` is called from one consumer, never concurrently.** There is
 *   nothing to synchronise, and a batch's order is the order things happened
 *   in.
 * - **It may take as long as it wants.** Nothing that writes a signal is
 *   waiting on it.
 * - **It should not throw.** If it does, the failure is reported to
 *   `onExportError` and the next exporter still receives the batch: a
 *   collector being down is not a reason for a request to fail.
 *
 * The `resource` comes with every call rather than through a start hook, rather
 * than being fixed when the exporter is built — which is what lets one exporter
 * serve two telemetries. Most exporters here hold nothing; `fileExporter` is
 * the exception and says so.
 */
export interface Exporter {
	/**
	 * Declared as a property rather than a method so TypeScript checks its
	 * parameters contravariantly: an implementation that asks for a mutable
	 * `Signal[]` is rejected, and a batch stays what arrived.
	 */
	export: (
		resource: Resource,
		batch: readonly Signal[],
	) => void | Promise<void>;

	/**
	 * Called once, after the last batch has drained. Optional.
	 *
	 * The one exception is a drain that ran out of time: `close` is then called
	 * while an `export` may still be in flight, because the alternative is a
	 * process that will not exit. The timeout is reported to `onExportError`
	 * first, so it is never silent.
	 */
	close?: () => void | Promise<void>;
}
