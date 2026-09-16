import type { CallContext, Middleware, Next } from '@nxgt/httpyz';
import { isDetached, type SpanScope, span } from '@nxgt/telemetry';
import {
	callAttributes,
	callFailed,
	HTTP_STATUS,
	OPERATION,
	safeUrl,
	URL_FULL,
} from '../attributes/http';

/** The header that carries the trace across the wire. */
export const TRACEPARENT = 'traceparent';

export interface TracingOptions {
	/**
	 * Whether this call gets a span at all. Default: every call does.
	 *
	 * Nothing is skipped by default. A library that decides for you which calls
	 * do not matter is a library that hides the one that did.
	 */
	readonly traced?: (call: CallContext) => boolean;
	/**
	 * The span's name. Default: the `operationId` when the call has one, and
	 * `"<METHOD> <path>"` otherwise — where the path is the template the caller
	 * wrote, `/employees/{id}`, not the one it filled in.
	 */
	readonly spanName?: (call: CallContext, request: Request) => string;
	/**
	 * What goes in `url.full`. Default: the URL with its userinfo removed.
	 * Return `undefined` to record no URL at all.
	 */
	readonly url?: (request: Request) => string | undefined;
}

/**
 * One client span per call, with the current `traceparent` on the way out.
 *
 * ```ts
 * const api = createHttpClient({ baseUrl, middlewares: [tracing()] });
 * ```
 *
 * Inside a server span, this is the half that makes a trace a trace: the
 * outgoing request carries the header that lets the service on the other end
 * continue it, and it is taken from whatever span is open **now** rather than
 * from anything the caller passed. Outside any span it is a no-op — the call
 * still goes out, and nothing is emitted.
 *
 * A client span **fails at `400`**, not at `500`. A `404` answered by a server
 * is that server working; the same `404` received by a caller is a call that
 * did not do what it was for.
 */
export function tracing(options: TracingOptions = {}): Middleware {
	// Every hook is application code on the path that decides whether a call is
	// observed, so one that throws costs its own answer and nothing else.
	const traced = guarded(options.traced ?? always, always);
	const named = guarded(options.spanName ?? defaultName, defaultName);
	const url = guarded(options.url ?? defaultUrl, nothing);

	return async (
		request: Request,
		next: Next,
		call: CallContext,
	): Promise<Response> => {
		if (!traced(call)) return next(request);

		return span(
			named(call, request),
			{ kind: 'client', attributes: attributesFor(call, request, url) },
			async (scope) => {
				const outgoing = carrying(request, scope);
				const reply = await next(outgoing);

				record(scope, reply);
				return reply;
			},
		);
	};
}

/**
 * The request with this span's `traceparent` on it.
 *
 * **A detached scope is not sent.** With no telemetry installed, `traceparent()`
 * is `00-0…0-0…0-00` — all zeros, which this library's own parser rejects and
 * which the W3C specification says is invalid. Sending it is worse than sending
 * nothing: a strict receiver refuses the request, and a lenient one starts a
 * fresh trace exactly as an absent header would.
 *
 * The header is set on the request in place where that is allowed, and a copy
 * is made where it is not: a `Request` built from a `Response`'s body, or one
 * some other middleware froze, would otherwise throw here — and a call must not
 * fail because it was being traced.
 */
function carrying(request: Request, scope: SpanScope): Request {
	if (isDetached(scope.context)) return request;

	const traceparent = scope.traceparent();

	try {
		request.headers.set(TRACEPARENT, traceparent);
		return request;
	} catch {
		try {
			const headers = new Headers(request.headers);
			headers.set(TRACEPARENT, traceparent);
			return new Request(request, { headers });
		} catch {
			// Nothing to be done: the call goes out untraced rather than not at
			// all. The span is still recorded on this side.
			return request;
		}
	}
}

function record(scope: SpanScope, reply: Response): void {
	let status: number;
	try {
		status = reply.status;
	} catch {
		return;
	}

	scope.attribute(HTTP_STATUS, status);
	if (callFailed(status) && scope.status === 'ok') scope.status = 'error';
}

function attributesFor(
	call: CallContext,
	request: Request,
	url: (request: Request) => string | undefined,
): Record<string, unknown> {
	const recorded = url(request);

	return {
		...callAttributes(request, method(call)),
		// The hook decides the URL, including deciding there is not one.
		[URL_FULL]: recorded,
		...(call.operationId === undefined
			? {}
			: { [OPERATION]: call.operationId }),
	};
}

/**
 * The method is uppercased here and in `http.request.method`. `@nxgt/httpyz`
 * passes it as the caller wrote it — `api.get(…)` gives `'get'` — and the
 * semantic conventions want `GET`, so a dashboard that groups by method does
 * not end up with two of each.
 */
function defaultName(call: CallContext): string {
	return call.operationId ?? `${method(call)} ${call.path}`;
}

export function method(call: CallContext): string {
	return call.method.toUpperCase();
}

function defaultUrl(request: Request): string | undefined {
	return safeUrl(request.url)?.href;
}

/** A hook, and what to ask instead when it throws. */
function guarded<A extends unknown[], T>(
	hook: (...args: A) => T,
	fallback: (...args: A) => T,
): (...args: A) => T {
	return (...args) => {
		try {
			return hook(...args);
		} catch {
			return fallback(...args);
		}
	};
}

function always(): true {
	return true;
}

function nothing(): undefined {
	return undefined;
}
