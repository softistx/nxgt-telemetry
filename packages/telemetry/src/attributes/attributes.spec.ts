import { describe, expect, test } from 'bun:test';
import {
	attributesOf,
	coerceAttribute,
	EMPTY_ATTRIBUTES,
	isEmptyAttributes,
	mergeAttributes,
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
