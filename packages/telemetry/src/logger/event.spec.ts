import { describe, expect, test } from 'bun:test';
import { event, INVALID_EVENT_ATTRIBUTE, isTelemetryEvent } from './event';
import type { StandardResult, StandardSchemaV1 } from './standard-schema';

/**
 * A hand-rolled Standard Schema, which is the point: Zod, Valibot and ArkType
 * all carry `~standard`, and none of them is a dependency here.
 */
function pick<T extends Record<string, unknown>>(
	keys: readonly string[],
	refuse = false,
): StandardSchemaV1<T, T> {
	return {
		'~standard': {
			version: 1,
			vendor: 'spec',
			validate(value: unknown): StandardResult<T> {
				if (refuse) return { issues: [{ message: 'no' }] };
				const input = value as Record<string, unknown>;
				const kept: Record<string, unknown> = {};
				for (const key of keys) {
					if (key in input) kept[key] = input[key];
				}
				return { value: kept as T };
			},
		},
	};
}

describe('an event with no schema', () => {
	test('is its name and the fields it was given', () => {
		const Charged = event('checkout.charged');
		expect(Charged({ orderId: 'o-1' })).toEqual({
			name: 'checkout.charged',
			attributes: { orderId: 'o-1' },
		});
	});

	test('takes no fields at all', () => {
		expect(event('checkout.started')()).toEqual({
			name: 'checkout.started',
			attributes: {},
		});
	});
});

/**
 * Declaring what you log makes choosing what is logged the same act as writing
 * the code. This is the assertion that carries that argument: a field nobody
 * declared does not reach the log, however it got into the object.
 */
describe('an event with a schema', () => {
	const Charged = event(
		'checkout.charged',
		pick<{ orderId: string; amount: number }>(['orderId', 'amount']),
	);

	test('emits what the schema returned, and nothing else', () => {
		const order = { orderId: 'o-1', amount: 4200, cardNumber: '4111…' };
		expect(Charged(order as never)).toEqual({
			name: 'checkout.charged',
			attributes: { orderId: 'o-1', amount: 4200 },
		});
	});

	test('coerces what it kept', () => {
		const At = event('checkout.at', pick<{ at: Date }>(['at']));
		expect(At({ at: new Date(0) } as never).attributes).toEqual({
			at: '1970-01-01T00:00:00.000Z',
		});
	});
});

describe('an event the schema will not accept', () => {
	test('still logs, marked, rather than throwing', () => {
		const Charged = event('checkout.charged', pick([], true));
		const built = Charged({ orderId: 'o-1' } as never);

		expect(built.name).toBe('checkout.charged');
		expect(built.attributes).toEqual({
			orderId: 'o-1',
			[INVALID_EVENT_ATTRIBUTE]: true,
		});
		expect(built.invalid).toBe(true);
	});

	test('a schema that throws is the same', () => {
		const hostile: StandardSchemaV1 = {
			'~standard': {
				version: 1,
				vendor: 'spec',
				validate() {
					throw new Error('broken schema');
				},
			},
		};

		expect(event('x', hostile)({} as never).invalid).toBe(true);
	});

	/**
	 * Nothing here may await: `log.info` is called from constructors and from
	 * `catch` blocks, where an async logger cannot be called at all.
	 */
	test('a schema that answers asynchronously is the same', () => {
		const slow: StandardSchemaV1 = {
			'~standard': {
				version: 1,
				vendor: 'spec',
				validate: async () => ({ value: {} }),
			},
		};

		expect(event('x', slow)({ a: 1 } as never).invalid).toBe(true);
	});
});

describe('a schema that returns something that is not a record', () => {
	test('logs it under `value` rather than dropping it', () => {
		const scalar: StandardSchemaV1 = {
			'~standard': {
				version: 1,
				vendor: 'spec',
				validate: () => ({ value: 'charged' }),
			},
		};

		expect(event('x', scalar)({} as never).attributes).toEqual({
			value: 'charged',
		});
	});
});

describe('isTelemetryEvent', () => {
	test('tells an event from a message and from a bag of fields', () => {
		expect(isTelemetryEvent(event('x')())).toBe(true);
		expect(isTelemetryEvent('x')).toBe(false);
		expect(isTelemetryEvent({ orderId: 'o-1' })).toBe(false);
		expect(isTelemetryEvent(null)).toBe(false);
	});
});
