import {
	continuing,
	createTelemetry,
	type SpanScope,
	type Telemetry,
	type TelemetryOptions,
	withTelemetry,
} from '@nxgt/telemetry';
import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
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

	const traced = options.traced ?? (() => true);
	const spanName = options.spanName ?? ((c) => `${c.req.method} ${c.req.path}`);
	const route = options.route ?? defaultRoute;

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
 * `routePath(c, -1)` is the registered path of the handler at the end of the
 * chain; `routePath(c)` from inside a middleware would answer this middleware's
 * own pattern, which is `*`.
 */
function defaultRoute(c: Context): string | undefined {
	try {
		return routePath(c, -1);
	} catch {
		// A request that matched nothing has no route to report.
		return undefined;
	}
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
	let template: string | undefined;
	try {
		template = route(c);
	} catch {
		// A hook that throws must not replace the request's own failure.
		return;
	}

	// `*` — and hono's normalised `/*` — is this middleware's own pattern,
	// which is what `routePath` answers when nothing else matched.
	if (
		template === undefined ||
		template === '' ||
		template === '*' ||
		template === '/*'
	) {
		return;
	}

	scope.name = `${c.req.method} ${template}`;
	scope.attribute(HTTP_ROUTE, template);
}

/**
 * The status, the failure, and whether either marks the span.
 *
 * **Hono catches.** A handler that throws does not reject `next()`: the router
 * turns the exception into a `500` and leaves it on `c.error`, so the only
 * thing that knows what went wrong is that field. Reading it is what puts
 * `exception.type` on the span; without it the span says "error" and nothing
 * about why.
 *
 * **A 4xx is `ok`.** The client sent something the server refused, which is the
 * server working; only `5xx` is the server's fault.
 */
function record(c: Context, scope: SpanScope): void {
	if (c.error !== undefined) scope.fail(c.error);

	let status: number;
	try {
		status = c.res.status;
	} catch {
		return;
	}

	scope.attribute(HTTP_STATUS, status);
	if (serverFailed(status)) scope.status = 'error';
}
