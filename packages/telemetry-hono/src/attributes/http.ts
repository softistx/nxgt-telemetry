import type { Attributes } from '@nxgt/telemetry';

/**
 * The semantic conventions this middleware sets, by name. They are the ones a
 * backend's HTTP dashboards look for, and getting a name wrong means the
 * attribute is still there and the dashboard is still empty.
 *
 * `-httpyz` sets four of the same names on the client side. That duplication is
 * deliberate and recorded in `AGENTS.md`: a shared helper would make each
 * package depend on the other's host.
 */
export const HTTP_METHOD = 'http.request.method';
export const URL_PATH = 'url.path';
export const URL_SCHEME = 'url.scheme';
export const HTTP_ROUTE = 'http.route';
export const HTTP_STATUS = 'http.response.status_code';
export const SERVER_ADDRESS = 'server.address';
export const SERVER_PORT = 'server.port';

/** The status at which a server span is the server's fault, and not before. */
export const SERVER_ERROR_FROM = 500;

/**
 * What is known about a request **before** it is handled: the method, the path
 * as it arrived, and where it was addressed.
 *
 * The route is not here. It is not known until the router has matched, which is
 * after `next()`, and a span named for the path it arrived at would give a
 * dashboard one row per order id.
 */
export function requestAttributes(request: Request): Attributes {
	const url = safeUrl(request.url);

	return {
		[HTTP_METHOD]: request.method,
		...(url === undefined
			? {}
			: {
					[URL_PATH]: url.pathname,
					[URL_SCHEME]: url.protocol.replace(':', ''),
					// The host **without** the port, which goes in its own
					// attribute. `-httpyz` splits them the same way, and a
					// server span and the client span that called it have to
					// agree on a name every HTTP dashboard groups by.
					[SERVER_ADDRESS]: url.hostname,
					...(url.port === '' ? {} : { [SERVER_PORT]: Number(url.port) }),
				}),
	};
}

/**
 * Whether a reply says the server failed.
 *
 * **A 4xx is `ok`.** The client sent something the server refused, which is the
 * server working; counting it as an error is what makes an error rate that
 * nobody can act on. Only `5xx` marks the span.
 */
export function serverFailed(status: number): boolean {
	return status >= SERVER_ERROR_FROM;
}

function safeUrl(url: string): URL | undefined {
	try {
		return new URL(url);
	} catch {
		// A request whose URL this runtime will not parse still gets a span.
		return undefined;
	}
}
