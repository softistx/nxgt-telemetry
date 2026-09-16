import { describe, expect, test } from 'bun:test';
import {
	attributesOf,
	coerceAttribute,
	EMPTY_ATTRIBUTES,
	isEmptyAttributes,
	mergeAttributes,
	UNREADABLE,
} from './attributes';

/**
 * An attribute is a scalar, or a list of scalars, and the coercion must never
 * refuse a value: `log.info` is a total function, so anything a caller passes
 * has to come out as something a backend can hold.
 */
describe('coerceAttribute', () => {
	test('keeps what is already a scalar', () => {
		expect(coerceAttribute('charged')).toBe('charged');
		expect(coerceAttribute(42)).toBe(42);
		expect(coerceAttribute(0)).toBe(0);
		expect(coerceAttribute(false)).toBe(false);
		expect(coerceAttribute(null)).toBe(null);
	});

	test('renders what JSON has no number for', () => {
		expect(coerceAttribute(Number.NaN)).toBe('NaN');
		expect(coerceAttribute(Number.POSITIVE_INFINITY)).toBe('Infinity');
		expect(coerceAttribute(9007199254740993n)).toBe('9007199254740993');
	});

	test('renders an instant, and does not throw on an invalid one', () => {
		expect(coerceAttribute(new Date('2026-09-15T10:00:00.000Z'))).toBe(
			'2026-09-15T10:00:00.000Z',
		);
		expect(coerceAttribute(new Date(Number.NaN))).toBe('Invalid Date');
	});

	test('drops what cannot cross a wire at all', () => {
		expect(coerceAttribute(undefined)).toBe(null);
		expect(coerceAttribute(Symbol('x'))).toBe(null);
		expect(coerceAttribute(() => 1)).toBe(null);
	});

	test('keeps a list of scalars, and flattens a nested one into text', () => {
		expect(coerceAttribute(['a', 1, true])).toEqual(['a', 1, true]);
		expect(coerceAttribute([['a']])).toEqual(['["a"]']);
	});

	test('renders structure as JSON rather than refusing it', () => {
		expect(coerceAttribute({ orderId: 'o-1' })).toBe('{"orderId":"o-1"}');
	});

	test('a circular object still says something', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(coerceAttribute(circular)).toBe('[object Object]');
	});

	test('a toJSON that throws does not propagate', () => {
		const hostile = {
			toJSON() {
				throw new Error('no');
			},
		};
		expect(coerceAttribute(hostile)).toBe('[object Object]');
	});
});

/**
 * Decision 3: writing a signal never fails. Everything below reaches
 * application code — a getter, an `ownKeys` trap, a `toString` — from a path
 * that a `catch` block calls.
 */
describe('a hostile value', () => {
	test('a getter that throws reads as unreadable, not as an exception', () => {
		const hostile = {
			get computed(): string {
				throw new Error('getter');
			},
		};

		expect(() => attributesOf(hostile)).not.toThrow();
		expect(attributesOf(hostile)).toEqual({ computed: UNREADABLE });
	});

	test('an ownKeys trap that throws gives up on the whole record', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('ownKeys');
				},
			},
		);

		expect(() => attributesOf(hostile)).not.toThrow();
		expect(attributesOf(hostile)).toBe(EMPTY_ATTRIBUTES);
	});

	test('a revoked Proxy does not escape', () => {
		const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
		revoke();

		expect(() => attributesOf(proxy)).not.toThrow();
		expect(() => coerceAttribute(proxy)).not.toThrow();
	});

	test('a toString that throws does not escape', () => {
		const hostile = {
			toString() {
				throw new Error('toString');
			},
			toJSON() {
				throw new Error('toJSON');
			},
		};

		expect(coerceAttribute(hostile)).toBe(UNREADABLE);
	});

	test('one unreadable key does not cost the others', () => {
		const mixed = {
			orderId: 'o-1',
			get computed(): string {
				throw new Error('getter');
			},
			amount: 4200,
		};

		expect(attributesOf(mixed)).toEqual({
			orderId: 'o-1',
			computed: UNREADABLE,
			amount: 4200,
		});
	});
});

describe('attributesOf', () => {
	test('drops undefined and keeps an explicit null', () => {
		expect(
			attributesOf({ orderId: 'o-1', code: undefined, reason: null }),
		).toEqual({
			orderId: 'o-1',
			reason: null,
		});
	});

	test('returns the shared empty for nothing at all', () => {
		expect(attributesOf(undefined)).toBe(EMPTY_ATTRIBUTES);
		expect(attributesOf({})).toBe(EMPTY_ATTRIBUTES);
		expect(attributesOf({ code: undefined })).toBe(EMPTY_ATTRIBUTES);
	});
});

describe('mergeAttributes', () => {
	test('the right-hand side wins', () => {
		expect(mergeAttributes({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
	});

	test('neither argument is modified', () => {
		const left = { a: 1 };
		const right = { b: 2 };
		mergeAttributes(left, right);
		expect(left).toEqual({ a: 1 });
		expect(right).toEqual({ b: 2 });
	});

	test('an empty side is returned as the other one, without copying', () => {
		const left = { a: 1 };
		expect(mergeAttributes(left, EMPTY_ATTRIBUTES)).toBe(left);
		expect(mergeAttributes(EMPTY_ATTRIBUTES, left)).toBe(left);
	});

	test('isEmptyAttributes sees an object with no keys', () => {
		expect(isEmptyAttributes(EMPTY_ATTRIBUTES)).toBe(true);
		expect(isEmptyAttributes({})).toBe(true);
		expect(isEmptyAttributes({ a: null })).toBe(false);
	});
});
