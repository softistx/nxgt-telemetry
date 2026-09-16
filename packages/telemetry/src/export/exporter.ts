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
 * The `resource` comes with every call rather than through a start hook, so an
 * exporter can be stateless and can be handed to two telemetries.
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

	/** Called once, after the last batch has drained. Optional. */
	close?: () => void | Promise<void>;
}
