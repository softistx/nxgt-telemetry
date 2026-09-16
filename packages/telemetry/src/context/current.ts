import * as asyncHooks from 'node:async_hooks';
import {
	type Attributes,
	attributesOf,
	EMPTY_ATTRIBUTES,
	mergeAttributes,
} from '../attributes/attributes';
import { installedTelemetry, type Telemetry } from '../telemetry/telemetry';
import { renderTraceparent, type SpanContext } from '../trace/ids';

/**
 * What travels with the work: which telemetry is writing, which span is open,
 * and the attributes everything inside inherits.
 */
export interface TelemetryContext {
	readonly telemetry: Telemetry;
	/** Absent between `withTelemetry` and the first `span`. */
	readonly span?: SpanContext;
	readonly attributes: Attributes;
}

/**
 * The current context lives in an `AsyncLocalStorage`, and that is the whole
 * design.
 *
 * It propagates through every `await`, every timer and every promise chain:
 * into everything started inside a span, out of nothing, and correct after any
 * number of suspensions. A module-level `let current` would look right in
 * development and start attributing one request's spans to another under
 * concurrency — a bug with no stack trace and no failing test, in the tool
 * meant to make such bugs visible.
 *
 * It is also readable **synchronously**, which is what lets `log.info()` stay a
 * plain function: a log written from a constructor, from a `catch` in ordinary
 * code or from a callback still has to come out, and an async logger cannot be
 * called from any of them.
 */
const storage = createStorage();

export function currentContext(): TelemetryContext | undefined {
	return storage.getStore();
}

/** Runs `fn` with `context` current, and restores whatever was there after. */
export function runWithContext<T>(context: TelemetryContext, fn: () => T): T {
	return storage.run(context, fn);
}

/**
 * The telemetry a logger or a span should write to: the one **in scope** first,
 * the **installed** one second.
 *
 * That order is what lets two suites in one process each collect their own
 * signals, and it is why `withTelemetry` exists.
 */
export function resolveTelemetry(): Telemetry | undefined {
	return currentContext()?.telemetry ?? installedTelemetry();
}

/** Runs `fn` with `telemetry` in scope, in place of the installed one. */
export function withTelemetry<T>(telemetry: Telemetry, fn: () => T): T {
	const context = currentContext();
	return runWithContext(
		{
			telemetry,
			...(context?.span === undefined ? {} : { span: context.span }),
			attributes: context?.attributes ?? EMPTY_ATTRIBUTES,
		},
		fn,
	);
}

/**
 * Runs `fn` with these attributes inherited by every log and span inside it.
 *
 * Outside any context it runs `fn` unchanged: attaching attributes to nothing
 * is not an error, and a library that does it must work in an application that
 * has never heard of this one.
 */
export function withAttributes<T>(
	attributes: Readonly<Record<string, unknown>>,
	fn: () => T,
): T {
	const context = currentContext();
	if (context === undefined) return fn();

	return runWithContext(
		{
			...context,
			attributes: mergeAttributes(context.attributes, attributesOf(attributes)),
		},
		fn,
	);
}

/** The span open right here, if there is one. */
export function currentSpan(): SpanContext | undefined {
	return currentContext()?.span;
}

/** The header to send with an outgoing call, so the trace continues. */
export function currentTraceparent(): string | undefined {
	const span = currentSpan();
	return span === undefined ? undefined : renderTraceparent(span);
}

/** The attributes everything written here inherits. */
export function currentAttributes(): Attributes {
	return currentContext()?.attributes ?? EMPTY_ATTRIBUTES;
}

interface ContextStorage {
	getStore(): TelemetryContext | undefined;
	run<T>(context: TelemetryContext, fn: () => T): T;
}

/**
 * A runtime with no `node:async_hooks` — a browser bundle, where the builtin is
 * shimmed away — falls back to a single variable. There is one request there,
 * so it is correct; it is the only mutable module-level context in this
 * library, and it exists so the package imports at all.
 */
function createStorage(): ContextStorage {
	const AsyncLocalStorage = asyncHooks.AsyncLocalStorage;
	if (typeof AsyncLocalStorage === 'function') {
		return new AsyncLocalStorage<TelemetryContext>();
	}

	let current: TelemetryContext | undefined;
	return {
		getStore: () => current,
		run<T>(context: TelemetryContext, fn: () => T): T {
			const previous = current;
			current = context;
			try {
				return fn();
			} finally {
				current = previous;
			}
		},
	};
}
