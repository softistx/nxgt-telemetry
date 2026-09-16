import { describe, expect, test } from 'bun:test';
import { requestAttributes, SERVER_ERROR_FROM, serverFailed } from './http';

describe('requestAttributes', () => {
	test('is what is known before the handler runs', () => {
		expect(
			requestAttributes(
				new Request('https://checkout.example/orders/o-1?page=2', {
					method: 'POST',
				}),
			),
		).toEqual({
			'http.request.method': 'POST',
			'url.path': '/orders/o-1',
			'url.scheme': 'https',
			'server.address': 'checkout.example',
		});
	});

	/**
	 * The route is not here. It is not known until the router has matched, and
	 * a span named for the path it arrived at gives a dashboard one row per
	 * order id.
	 */
	test('does not carry the route', () => {
		const found = requestAttributes(
			new Request('https://checkout.example/orders/o-1'),
		);
		expect(found['http.route']).toBeUndefined();
	});

	test('keeps the port, because two services can share a host', () => {
		expect(
			requestAttributes(new Request('http://localhost:8787/health'))[
				'server.address'
			],
		).toBe('localhost:8787');
	});

	/** A request whose URL this runtime will not parse still gets a span. */
	test('a URL it cannot parse still yields the method', () => {
		const unparsable = {
			method: 'GET',
			get url() {
				return 'not a url';
			},
		} as Request;

		expect(requestAttributes(unparsable)).toEqual({
			'http.request.method': 'GET',
		});
	});
});

describe('serverFailed', () => {
	/**
	 * The client sent something the server refused, which is the server
	 * working. Counting it as an error is what makes an error rate nobody can
	 * act on.
	 */
	test('only a 5xx is the server failing', () => {
		expect(serverFailed(200)).toBe(false);
		expect(serverFailed(302)).toBe(false);
		expect(serverFailed(401)).toBe(false);
		expect(serverFailed(404)).toBe(false);
		expect(serverFailed(499)).toBe(false);
		expect(serverFailed(500)).toBe(true);
		expect(serverFailed(503)).toBe(true);
	});

	test('the boundary is 500, and it is exported', () => {
		expect(SERVER_ERROR_FROM).toBe(500);
		expect(serverFailed(SERVER_ERROR_FROM)).toBe(true);
	});
});
