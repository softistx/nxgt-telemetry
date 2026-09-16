import type { SpanScope, Telemetry } from '@nxgt/telemetry';

/**
 * What the middleware puts on the request context.
 *
 * Augmenting `ContextVariableMap` rather than asking for a typed `Env` is what
 * makes `c.get('span')` typed in a handler that knows nothing about this
 * package — which is the whole point of putting it there.
 *
 * It is declared here and re-exported from the entry point, so importing
 * anything from `@nxgt/telemetry-hono` is what turns it on.
 */
declare module 'hono' {
	interface ContextVariableMap {
		/**
		 * The telemetry this request is being written to.
		 *
		 * **Optional**, and the compiler enforces it: a request `traced` refused
		 * never had a middleware set it, so `c.get('telemetry')` is `undefined`
		 * there. Type safety is what the compiler rejects, not what a README
		 * claims.
		 */
		telemetry?: Telemetry;
		/** The server span around this request. `undefined` when `traced` said no. */
		span?: SpanScope;
	}
}

/** The keys, as values, for code that sets them by name. */
export const TELEMETRY_VARIABLE = 'telemetry';
export const SPAN_VARIABLE = 'span';
