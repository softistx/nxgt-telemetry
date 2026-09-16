import {
	continuing,
	createTelemetry,
	type SpanScope,
	type Telemetry,
	type TelemetryOptions,
	withTelemetry,
} from '@nxgt/telemetry';
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import {
	HTTP_ROUTE,
	HTTP_STATUS,
	requestAttributes,
	serverFailed,
} from '../attributes/http';
import { SPAN_VARIABLE, TELEMETRY_VARIABLE } from './variables';

/** The hooks both shapes of the middleware share. */
interface Hooks {
	/**
	 * Whether this request gets a span at all. Default: every request does.
	 *
	 * This is the health-check hook. Nothing is skipped by default, because a
	 * library that decides for you which requests do not matter is a library
	 * that hides the one that did.
	 */
	readonly traced?: (c: Context) => boolean;
	/**
	 * The span's name **before** routing. Default `"<METHOD> <path>"`, which is
	 * replaced by `"<METHOD> <route>"` once the router has matched.
	 */
	readonly spanName?: (c: Context) => string;
	/**
	 * The route template, once the handler has run. Default `routePath(c, -1)`.
	 * Return `undefined` to leave the span named as it was.
	 */
	readonly route?: (c: Context) => string | undefined;
}

/**
 * Either build a telemetry from `service` and the usual options, or hand one
 * over as `instance`. The compiler refuses both at once: `service` would be
 * silently ignored beside an instance that already has one.
 */
export type TelemetryMiddlewareOptions =
	| (Hooks &
			TelemetryOptions & {
				/** The service name. Everything groups by it. */
				readonly service: string;
				readonly instance?: undefined;
			})
	| (Hooks & {
			/** An existing telemetry. It is **adopted, not closed**. */
			readonly instance: Telemetry;
			readonly service?: undefined;
	  });

/** The middleware, with the telemetry it is writing to. */
export interface TelemetryMiddleware extends MiddlewareHandler {
	/**
	 * The telemetry this middleware uses — the one it built, or the one it was
	 * handed. `close()` it on shutdown; nothing here does that for you, because
	 * a middleware has no shutdown to hook.
	 */
	readonly telemetry: Telemetry;
}

/**
 * One server span per request, around the whole handler.
 *
 * ```ts
 * const tracing = telemetry({
 *   service: 'checkout',
 *   exporters: [otlpExporter({ endpoint: 'http://localhost:4318' })],
 *   traced: (c) => c.req.path !== '/health',
 * });
 *
 * app.use('*', tracing);
 * process.on('SIGTERM', () => void tracing.telemetry.close());
 * ```
 *
 * The span **wraps `next()`** rather than being two hooks. That is what puts
 * the whole handler — and everything it awaits, and everything it throws —
 * inside the span's context, so `log.info()` in a service three calls down
 * carries this request's `traceId` without anything being passed to it.
 *
 * An inbound `traceparent` continues its trace. An unusable one is not an
 * error: it starts a fresh trace, because the header came from a stranger.
 */
export function telemetry(
	options: TelemetryMiddlewareOptions,
): TelemetryMiddleware {
	const instance =
		options.instance ?? createTelemetry(options.service, options).install();

	// Every hook is application code, and every hook is on the path that decides
	// whether a request is observed. One that throws must cost its answer, not
	// the request: a predicate that raises would otherwise turn observability
	// into an outage.
	const traced = guarded(options.traced ?? always, always);
	const spanName = guarded(options.spanName ?? defaultName, defaultName);
	const route = guarded(options.route ?? defaultRoute, nothing);

	const handler: MiddlewareHandler = async (c, next) => {
		if (!traced(c)) return next();

		return withTelemetry(instance, () =>
			continuing(
				c.req.header('traceparent'),
				spanName(c),
				{ kind: 'server', attributes: requestAttributes(c.req.raw) },
				async (scope) => {
					c.set(TELEMETRY_VARIABLE, instance);
					c.set(SPAN_VARIABLE, scope);

					try {
						await next();
					} finally {
						// Even a handler that threw was routed, and the route is
						// what the span should be called either way.
						rename(c, scope, route);
					}

					record(c, scope);
				},
			),
		);
	};

	return Object.assign(handler, { telemetry: instance });
}

/**
 * The route template, which is only known **after** the router has matched.
 *
 * It is the last *handler* among the matched routes, not simply the last match:
 * `routePath(c)` answers whichever route ran last, which is a middleware
 * registered after the routes, and `routePath(c, -1)` — besides taking a second
 * argument only since hono 4.10 — answers the last entry whatever it is. Hono's
 * own `matchedRoutes` example tells a handler from a middleware by its arity,
 * because a middleware takes `(c, next)` and a handler takes `(c)`.
 *
 * Nothing matched means there is no route to report: a 404, or a request that
 * only ever reached `app.use('*', …)`.
 */
function defaultRoute(c: Context): string | undefined {
	const handled = matchedRoutes(c).filter(
		(matched) =>
			(matched.handler as (...args: unknown[]) => unknown).length < 2,
	);

	return handled.at(-1)?.path;
}

function defaultName(c: Context): string {
	return `${c.req.method} ${c.req.path}`;
}

/** A hook, and what to ask instead when it throws. */
function guarded<T>(
	hook: (c: Context) => T,
	fallback: (c: Context) => T,
): (c: Context) => T {
	return (c) => {
		try {
			return hook(c);
		} catch {
			return fallback(c);
		}
	};
}

function always(): true {
	return true;
}

function nothing(): undefined {
	return undefined;
}

/**
 * A span named for the path it arrived at gives a dashboard one row per order
 * id. The template is the name; the path stays as `url.path`.
 */
function rename(
	c: Context,
	scope: SpanScope,
	route: (c: Context) => string | undefined,
): void {
	const template = route(c);

	// There is no wildcard to filter out here: the template comes from a
	// handler, and a handler's registered path is a route the application
	// chose — `app.get('/files/*')` included. The patterns worth dropping are
	// `app.use`'s, and those never reach this.
	if (template === undefined || template === '') return;

	scope.name = `${c.req.method} ${template}`;
	scope.attribute(HTTP_ROUTE, template);
}

/**
 * The status, the failure, and which of them decides how the span reads.
 *
 * **Hono catches.** A handler that throws does not reject `next()`: the router
 * turns the exception into a reply and leaves it on `c.error`, so the only
 * thing that knows what went wrong is that field. Reading it is what puts
 * `exception.type` on the span; without it the span says "error" and nothing
 * about why.
 *
 * **The reply decides the status, not the exception.** `HTTPException` is how
 * a Hono application says `401` — it is what `basicAuth`, `bearerAuth`, `jwt`
 * and the validators all throw — so letting a thrown failure mark the span
 * would put every rejected login in the error rate. A `4xx` is the server
 * working. Only a `5xx` is the server's fault, and only then does an `ok` span
 * become an `error` one.
 *
 * A status the scope already decided is left alone: an abort answered with a
 * `500` stays `cancelled`, which is the whole reason that status exists.
 */
function record(c: Context, scope: SpanScope): void {
	const status = statusOf(c);

	if (c.error !== undefined) {
		const before = scope.status;
		// Records `exception.*`. It also sets a status, which is right when the
		// exception is the reply and wrong when the reply is a 4xx.
		scope.fail(c.error);
		if (status !== undefined && !serverFailed(status)) scope.status = before;
	}

	if (status === undefined) return;

	scope.attribute(HTTP_STATUS, status);
	if (serverFailed(status) && scope.status === 'ok') scope.status = 'error';
}

function statusOf(c: Context): number | undefined {
	try {
		return c.res.status;
	} catch {
		// A response this runtime will not build is not worth losing the span
		// over.
		return undefined;
	}
}
