import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { errorInfo, isAbort } from './error';

/**
 * A `throw` accepts anything, and `errorInfo` runs inside a `catch`. A second
 * failure here would replace the application's first one and lose it, so every
 * case below asserts that reading a hostile value produces a record rather than
 * an exception.
 */
describe('a well-behaved failure', () => {
	test('is its name, message and stack', () => {
		const info = errorInfo(new RangeError('no funds'));
		expect(info.type).toBe('RangeError');
		expect(info.message).toBe('no funds');
		expect(info.stackTrace).toContain('RangeError');
	});

	test('keeps its type when stacks are off', () => {
		expect(errorInfo(new Error('no'), false)).toEqual({
			type: 'Error',
			message: 'no',
		});
	});

	/**
	 * `name` is inherited from `Error.prototype` unless a subclass assigns it,
	 * and `exception.type` is the field a dashboard groups by. `stx-telemetry`
	 * records the class name, and the two estates have to agree.
	 */
	test('a subclass is recorded under its own class name', () => {
		class ChargeRefused extends Error {}
		expect(errorInfo(new ChargeRefused('51')).type).toBe('ChargeRefused');
	});

	test('an assigned name still wins', () => {
		const failure = new Error('gone');
		failure.name = 'AbortError';
		expect(errorInfo(failure).type).toBe('AbortError');
	});
});

describe('a failure from another realm', () => {
	const alien = runInNewContext('new Error("boom")') as Error;

	test('is not an instance of our Error', () => {
		expect(alien instanceof Error).toBe(false);
	});

	test('and is still recorded with its message, not as an empty object', () => {
		const info = errorInfo(alien);
		expect(info.type).toBe('Error');
		expect(info.message).toBe('boom');
	});
});

describe('what is not an Error at all', () => {
	test('a thrown string, number and null each say what they were', () => {
		expect(errorInfo('no')).toEqual({ type: 'string', message: 'no' });
		expect(errorInfo(51)).toEqual({ type: 'number', message: '51' });
		expect(errorInfo(null)).toEqual({ type: 'null', message: 'null' });
	});

	test('a thrown object is rendered', () => {
		expect(errorInfo({ code: 51 })).toEqual({
			type: 'Object',
			message: '{"code":51}',
		});
	});
});

describe('a hostile failure', () => {
	test('a name getter that throws does not escape', () => {
		const failure = new Error('boom');
		Object.defineProperty(failure, 'name', {
			get() {
				throw new Error('name getter');
			},
		});

		expect(() => errorInfo(failure)).not.toThrow();
		expect(errorInfo(failure).message).toBe('boom');
	});

	test('a message getter that throws does not escape', () => {
		const failure = new Error('boom');
		Object.defineProperty(failure, 'message', {
			get() {
				throw new Error('message getter');
			},
		});

		expect(() => errorInfo(failure)).not.toThrow();
		expect(errorInfo(failure).type).toBe('Error');
	});

	test('a stack getter that throws does not escape', () => {
		const failure = new Error('boom');
		Object.defineProperty(failure, 'stack', {
			get() {
				throw new Error('stack getter');
			},
		});

		expect(() => errorInfo(failure)).not.toThrow();
		expect(errorInfo(failure).stackTrace).toBeUndefined();
	});

	test('a revoked Proxy does not escape', () => {
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();

		expect(() => errorInfo(proxy)).not.toThrow();
		expect(errorInfo(proxy).type).toBeString();
	});

	test('a toJSON that throws does not escape', () => {
		const failure = {
			toJSON() {
				throw new Error('no');
			},
		};

		expect(() => errorInfo(failure)).not.toThrow();
	});
});

describe('isAbort', () => {
	test('is true for what an AbortSignal rejects with', () => {
		const aborted = new Error('gone');
		aborted.name = 'AbortError';
		const timedOut = new Error('late');
		timedOut.name = 'TimeoutError';

		expect(isAbort(aborted)).toBe(true);
		expect(isAbort(timedOut)).toBe(true);
	});

	test('is false for an ordinary failure, and for what is not one', () => {
		expect(isAbort(new Error('boom'))).toBe(false);
		expect(isAbort('AbortError')).toBe(false);
		expect(isAbort(null)).toBe(false);
		expect(isAbort(undefined)).toBe(false);
	});

	test('does not escape a name getter that throws', () => {
		const failure = {
			get name(): string {
				throw new Error('name getter');
			},
		};

		expect(() => isAbort(failure)).not.toThrow();
		expect(isAbort(failure)).toBe(false);
	});
});
