import type { Attributes } from '@nxgt/telemetry';

/**
 * The semantic conventions a **client** span carries.
 *
 * `-hono` sets four names that look the same. The duplication is deliberate and
 * recorded in `AGENTS.md`: a shared helper would make each package depend on
 * the other's host, and the two disagree about the thing that matters most —
 * which statuses are failures.
 */
export const HTTP_METHOD = 'http.request.method';
export const URL_FULL = 'url.full';
export const SERVER_ADDRESS = 'server.address';
export const SERVER_PORT = 'server.port';
export const HTTP_STATUS = 'http.response.status_code';
/**
 * The path as the caller wrote it: `/employees/{id}`. An OTel convention, and
 * the one thing that lets a backend group calls that differ only by their
 * parameters.
 */
export const URL_TEMPLATE = 'url.template';
/**
 * The call's name, when it had one: an OpenAPI `operationId`.
 *
 * This name is **not** in the OTel semantic conventions — there is none for it
 * — and it is an addition to the vocabulary this estate shares with
 * `stx-telemetry`. Its ktor module should use the same one.
 */
export const OPERATION = 'http.operation';

/**
 * The status at which a **client** span failed — and it is `400`, not `500`.
 *
 * This is where a client span and a server span disagree, and the asymmetry is
 * the point. A `404` answered by a server is that server working; the same
 * `404` received by a caller is a call that did not do what it was for. Both
 * readings are correct, and each belongs to the span on its own side of the
 * wire.
 */
export const CLIENT_ERROR_FROM = 400;

export function callFailed(status: number): boolean {
	return status >= CLIENT_ERROR_FROM;
}

/**
 * What is known about a call **before** it is sent.
 *
 * `url.full` has its **userinfo removed**: `https://user:token@api.example` is
 * a real way to carry a credential, and a span is read by everybody who reads
 * the dashboard. The query string is kept — it is usually what distinguishes
 * one call from another — so pass a `url` hook if yours carries a key.
 */
export function callAttributes(request: Request, method: string): Attributes {
	const url = safeUrl(request.url);

	return {
		[HTTP_METHOD]: method,
		...(url === undefined
			? {}
			: {
					[URL_FULL]: url.href,
					[SERVER_ADDRESS]: url.hostname,
					...(url.port === '' ? {} : { [SERVER_PORT]: Number(url.port) }),
				}),
	};
}

/** The URL as a span may repeat it: everything but the credentials. */
export function safeUrl(url: string): URL | undefined {
	try {
		const parsed = new URL(url);
		parsed.username = '';
		parsed.password = '';
		return parsed;
	} catch {
		// A URL this runtime will not parse still gets a span.
		return undefined;
	}
}
