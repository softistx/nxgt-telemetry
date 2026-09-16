import { afterEach, describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { withAttributes, withTelemetry } from '../context/current';
import type { Exporter } from '../export/exporter';
import type { LogRecord, Signal } from '../model/signal';
import { span } from '../span/span';
import { createTelemetry, uninstallTelemetry } from '../telemetry/telemetry';
import { neverSample } from '../trace/sampler';
import { event } from './event';
import { createLogger } from './logger';

afterEach(() => uninstallTelemetry());

function collecting(options: Parameters<typeof createTelemetry>[1] = {}) {
	const signals: Signal[] = [];
	const exporter: Exporter = {
		export(_resource, batch) {
			signals.push(...batch);
		},
	};
	const telemetry = createTelemetry('checkout', {
		...options,
		exporters: [exporter],
		batch: 1,
	});

	const logs = async (): Promise<LogRecord[]> => {
		await telemetry.close();
		return signals.filter((s): s is LogRecord => s.type === 'log');
	};

	return { telemetry, logs };
}

const log = createLogger('CheckoutService');

describe('with nothing installed', () => {
	test('a log is dropped in silence', () => {
		expect(() => log.info('charged')).not.toThrow();
		expect(log.enabled('error')).toBe(false);
	});
});

describe('a line', () => {
	test('carries its message, its source, its level and its attributes', async () => {
		const { telemetry, logs } = collecting();

		withTelemetry(telemetry, () => log.warn('charge refused', { code: 51 }));

		const [record] = await logs();
		expect(record).toMatchObject({
			type: 'log',
			severity: 'warn',
			name: 'charge refused',
			source: 'CheckoutService',
			attributes: { code: 51 },
		});
		expect(record?.span).toBeUndefined();
	});

	test('carries the fields a declared event declared', async () => {
		const { telemetry, logs } = collecting();
		const Charged = event('checkout.charged');

		withTelemetry(telemetry, () =>
			log.info(Charged({ orderId: 'o-1', amount: 4200 })),
		);

		const [record] = await logs();
		expect(record?.name).toBe('checkout.charged');
		expect(record?.attributes).toEqual({ orderId: 'o-1', amount: 4200 });
	});

	test('merges the event fields with the ones given at the call', async () => {
		const { telemetry, logs } = collecting();
		const Charged = event('checkout.charged');

		withTelemetry(telemetry, () =>
			log.info(Charged({ orderId: 'o-1' }), { attempt: 2 }),
		);

		expect((await logs())[0]?.attributes).toEqual({
			orderId: 'o-1',
			attempt: 2,
		});
	});
});

describe('the severity floor', () => {
	test('drops what is below it', async () => {
		const { telemetry, logs } = collecting();

		withTelemetry(telemetry, () => {
			log.debug('quiet');
			log.info('loud');
		});

		expect((await logs()).map((r) => r.name)).toEqual(['loud']);
	});

	test('and `enabled` says so before anything is built', () => {
		const { telemetry } = collecting();

		withTelemetry(telemetry, () => {
			expect(log.enabled('debug')).toBe(false);
			expect(log.enabled('info')).toBe(true);
			expect(log.enabled('error')).toBe(true);
		});
	});

	test('a lazy message below the floor is never built', async () => {
		const { telemetry, logs } = collecting();
		let built = 0;

		withTelemetry(telemetry, () => {
			log.debug(() => {
				built++;
				return 'expensive';
			});
			log.info(() => {
				built++;
				return 'wanted';
			});
		});

		expect(built).toBe(1);
		expect((await logs())[0]?.name).toBe('wanted');
	});

	test('a lazy message that throws still logs', async () => {
		const { telemetry, logs } = collecting();

		withTelemetry(telemetry, () =>
			log.info(() => {
				throw new TypeError('nope');
			}),
		);

		const [record] = await logs();
		expect(record?.name).toBe('[message failed to build]');
		expect(record?.attributes['telemetry.message.invalid']).toBe('TypeError');
	});
});

describe('a failure on a line', () => {
	test('is recorded, and told apart from a bag of fields', async () => {
		const { telemetry, logs } = collecting();

		withTelemetry(telemetry, () => {
			log.error('charge failed', new RangeError('no funds'));
			log.error('charge refused', { code: 51 });
			log.error('charge lost', new Error('gone'), { orderId: 'o-1' });
		});

		const [failed, refused, lost] = await logs();
		expect(failed?.error?.type).toBe('RangeError');
		expect(failed?.attributes).toEqual({});
		expect(refused?.error).toBeUndefined();
		expect(refused?.attributes).toEqual({ code: 51 });
		expect(lost?.error?.type).toBe('Error');
		expect(lost?.attributes).toEqual({ orderId: 'o-1' });
	});

	test('a thrown string is a failure, not a bag of fields', async () => {
		const { telemetry, logs } = collecting();

		withTelemetry(telemetry, () => log.warn('odd', 'just a string'));

		expect((await logs())[0]?.error?.type).toBe('string');
	});
});

/**
 * Decision 3, on the path that matters most: the value handed to `log.error`
 * comes out of a `catch`, so it comes from code nobody here controls. Not one
 * of these may throw, and the line must still come out.
 */
describe('a hostile failure or bag of fields', () => {
	const hostile = () => {
		const failure = new Error('the real failure');
		Object.defineProperty(failure, 'name', {
			get() {
				throw new Error('name getter');
			},
		});
		return failure;
	};

	test('a failure whose name, message or stack getter throws still logs', async () => {
		const { telemetry, logs } = collecting();
		const message = new Error('boom');
		Object.defineProperty(message, 'message', {
			get() {
				throw new Error('message getter');
			},
		});
		const stack = new Error('boom');
		Object.defineProperty(stack, 'stack', {
			get() {
				throw new Error('stack getter');
			},
		});

		withTelemetry(telemetry, () => {
			expect(() => log.error('one', hostile())).not.toThrow();
			expect(() => log.error('two', message)).not.toThrow();
			expect(() => log.error('three', stack)).not.toThrow();
		});

		expect((await logs()).map((r) => r.name)).toEqual(['one', 'two', 'three']);
	});

	test('a revoked Proxy as the failure still logs', async () => {
		const { telemetry, logs } = collecting();
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();

		withTelemetry(telemetry, () => {
			expect(() => log.error('charge failed', proxy)).not.toThrow();
		});

		expect(await logs()).toHaveLength(1);
	});

	test('fields whose getter throws still log, marked unreadable', async () => {
		const { telemetry, logs } = collecting();

		withTelemetry(telemetry, () => {
			expect(() =>
				log.info('charged', {
					orderId: 'o-1',
					get computed(): string {
						throw new Error('getter');
					},
				}),
			).not.toThrow();
		});

		expect((await logs())[0]?.attributes).toEqual({
			orderId: 'o-1',
			computed: '[unreadable]',
		});
	});

	test('a Proxy whose ownKeys throws still logs', async () => {
		const { telemetry, logs } = collecting();
		const trapped = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('ownKeys');
				},
			},
		);

		withTelemetry(telemetry, () => {
			expect(() => log.info('charged', trapped)).not.toThrow();
		});

		expect(await logs()).toHaveLength(1);
	});

	test('a lazy message that throws a hostile failure still logs', async () => {
		const { telemetry, logs } = collecting();

		withTelemetry(telemetry, () => {
			expect(() =>
				log.info(() => {
					throw hostile();
				}),
			).not.toThrow();
		});

		expect((await logs())[0]?.name).toBe('[message failed to build]');
	});
});

/**
 * `warn(message, x)` and `warn(message, failure, attributes)` are one call at
 * runtime, and `x` decides. A plain object from a worker is still a plain
 * object: reading it as a failure would make its fields unindexable at the one
 * moment somebody is filtering on them.
 */
describe('telling a failure from a bag of fields', () => {
	test('a class instance and a Date are failures; a plain object is fields', async () => {
		const { telemetry, logs } = collecting();
		class Refused {}

		withTelemetry(telemetry, () => {
			log.warn('a', new Refused());
			log.warn('b', new Date(0));
			log.warn('c', { code: 51 });
			log.warn('d', Object.create(null));
		});

		const [a, b, c, d] = await logs();
		expect(a?.error?.type).toBe('Refused');
		expect(b?.error?.type).toBe('Date');
		expect(c?.error).toBeUndefined();
		expect(c?.attributes).toEqual({ code: 51 });
		expect(d?.error).toBeUndefined();
	});

	test('a plain object from another realm is fields, not a failure', async () => {
		const { telemetry, logs } = collecting();
		const alien = runInNewContext('({ code: 51 })') as Record<string, unknown>;

		withTelemetry(telemetry, () => log.warn('refused', alien));

		const [record] = await logs();
		expect(record?.error).toBeUndefined();
		expect(record?.attributes).toEqual({ code: 51 });
	});

	test('an Error from another realm is a failure, with its message', async () => {
		const { telemetry, logs } = collecting();
		const alien = runInNewContext('new Error("boom")') as Error;

		withTelemetry(telemetry, () => log.error('charge failed', alien));

		expect((await logs())[0]?.error?.message).toBe('boom');
	});

	test('a Proxy whose getPrototypeOf throws is read as a failure', async () => {
		const { telemetry, logs } = collecting();
		const trapped = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error('getPrototypeOf');
				},
			},
		);

		withTelemetry(telemetry, () => {
			expect(() => log.warn('odd', trapped)).not.toThrow();
		});

		expect((await logs())[0]?.error).toBeDefined();
	});
});

describe('inside a span', () => {
	test('a line carries that span, without being told', async () => {
		const { telemetry, logs } = collecting();

		await withTelemetry(telemetry, () =>
			span('charge', async (scope) => {
				log.info('charged');
				expect(scope.spanId).toBeDefined();
			}),
		);

		const [record] = await logs();
		expect(record?.span?.spanId).toBeDefined();
	});

	test('and the attributes the span and withAttributes put in scope', async () => {
		const { telemetry, logs } = collecting();

		await withTelemetry(telemetry, () =>
			span('charge', { attributes: { tenant: 'acme' } }, async () =>
				withAttributes({ orderId: 'o-1' }, () => {
					log.info('charged', { attempt: 2 });
				}),
			),
		);

		expect((await logs())[0]?.attributes).toEqual({
			tenant: 'acme',
			orderId: 'o-1',
			attempt: 2,
		});
	});

	test('the innermost attribute wins', async () => {
		const { telemetry, logs } = collecting();

		await withTelemetry(telemetry, () =>
			span('charge', { attributes: { tenant: 'acme' } }, async () => {
				log.info('charged', { tenant: 'other' });
			}),
		);

		expect((await logs())[0]?.attributes).toEqual({ tenant: 'other' });
	});

	/**
	 * Decision 4's second half. Sampling is a decision about the volume of
	 * traces; a log dropped because its trace was not kept is a log missing at
	 * precisely the moment somebody is reading logs to find out what happened.
	 */
	test('a log of an unsampled trace still comes out, with its traceId', async () => {
		const { telemetry, logs } = collecting({ sampler: neverSample });

		await withTelemetry(telemetry, () =>
			span('charge', async (scope) => {
				log.info('charged');
				expect(scope.context.sampled).toBe(false);
			}),
		);

		const [record] = await logs();
		expect(record?.name).toBe('charged');
		expect(record?.span?.sampled).toBe(false);
		expect(record?.span?.traceId).toBeDefined();
	});
});

describe('resolving the telemetry', () => {
	test('happens at each call, so a module-scope logger works', async () => {
		const { telemetry, logs } = collecting();
		const early = createLogger('Built.Before.Anything');

		withTelemetry(telemetry, () => early.info('late'));

		expect((await logs())[0]?.source).toBe('Built.Before.Anything');
	});

	test('and prefers the one in scope over the installed one', async () => {
		const installed = collecting();
		const scoped = collecting();
		installed.telemetry.install();

		withTelemetry(scoped.telemetry, () => log.info('scoped'));
		log.info('installed');

		expect((await scoped.logs()).map((r) => r.name)).toEqual(['scoped']);
		expect((await installed.logs()).map((r) => r.name)).toEqual(['installed']);
	});
});
