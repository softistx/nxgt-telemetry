import { describe, expect, test } from 'bun:test';
import { CLIENT_ERROR_FROM, callAttributes, callFailed, safeUrl } from './http';

describe('callAttributes', () => {
	test('is what is known before the call is sent', () => {
		expect(
			callAttributes(
				new Request('https://api.example:8443/employees/e-1?page=2'),
				'POST',
			),
		).toEqual({
			'http.request.method': 'POST',
			'url.full': 'https://api.example:8443/employees/e-1?page=2',
			'server.address': 'api.example',
			'server.port': 8443,
		});
	});

	test('a default port is not reported as one', () => {
		expect(
			callAttributes(new Request('https://api.example/x'), 'GET'),
		).not.toHaveProperty('server.port');
	});

	test('a URL it cannot parse still yields the method', () => {
		const unparsable = {
			get url() {
				return 'not a url';
			},
		} as Request;

		expect(callAttributes(unparsable, 'GET')).toEqual({
			'http.request.method': 'GET',
		});
	});
});

describe('safeUrl', () => {
	/** A span is read by everybody who reads the dashboard. */
	test('drops the userinfo and keeps everything else', () => {
		expect(safeUrl('https://user:s3cret@api.example/x?page=2#top')?.href).toBe(
			'https://api.example/x?page=2#top',
		);
	});

	test('answers nothing for what is not a URL', () => {
		expect(safeUrl('not a url')).toBeUndefined();
	});
});

describe('the names it uses', () => {
	/**
	 * `url.template` is the OTel convention and is what lets a backend group
	 * calls that differ only by their parameters. `http.operation` is **not** a
	 * convention — there is none for an OpenAPI `operationId` — so it is an
	 * addition to the vocabulary shared with `stx-telemetry`.
	 */
	test('are the ones the conventions give, where there is one', async () => {
		const {
			HTTP_METHOD,
			URL_FULL,
			SERVER_ADDRESS,
			SERVER_PORT,
			HTTP_STATUS,
			URL_TEMPLATE,
			OPERATION,
		} = await import('./http');

		expect([
			HTTP_METHOD,
			URL_FULL,
			URL_TEMPLATE,
			SERVER_ADDRESS,
			SERVER_PORT,
			HTTP_STATUS,
			OPERATION,
		]).toEqual([
			'http.request.method',
			'url.full',
			'url.template',
			'server.address',
			'server.port',
			'http.response.status_code',
			'http.operation',
		]);
	});
});

describe('callFailed', () => {
	/**
	 * Where a client span and a server span disagree, and the asymmetry is the
	 * point: a 404 answered by a server is that server working; the same 404
	 * received by a caller is a call that did not do what it was for.
	 */
	test('a client call fails at 400, not at 500', () => {
		expect(callFailed(200)).toBe(false);
		expect(callFailed(304)).toBe(false);
		expect(callFailed(399)).toBe(false);
		expect(callFailed(400)).toBe(true);
		expect(callFailed(404)).toBe(true);
		expect(callFailed(503)).toBe(true);
	});

	test('the boundary is exported, and it is 400', () => {
		expect(CLIENT_ERROR_FROM).toBe(400);
	});
});
