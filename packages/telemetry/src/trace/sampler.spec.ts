import { describe, expect, test } from 'bun:test';
import { randomTraceId, type TraceId } from './ids';
import { alwaysSample, neverSample, ratioSampler } from './sampler';

describe('the constant samplers', () => {
	test('answer without looking', () => {
		const traceId = randomTraceId();
		expect(alwaysSample.sample(traceId)).toBe(true);
		expect(neverSample.sample(traceId)).toBe(false);
	});
});

describe('ratioSampler', () => {
	test('refuses a ratio outside 0..1, where the mistake is', () => {
		expect(() => ratioSampler(-0.1)).toThrow(RangeError);
		expect(() => ratioSampler(1.5)).toThrow(RangeError);
		expect(() => ratioSampler(Number.NaN)).toThrow(RangeError);
	});

	test('0 and 1 are the constant samplers', () => {
		expect(ratioSampler(0)).toBe(neverSample);
		expect(ratioSampler(1)).toBe(alwaysSample);
	});

	/**
	 * The decision is a function of the trace id, not a coin toss. This is what
	 * lets two services at the same ratio keep the *same* traces whole; two
	 * services tossing independently at 10% keep a whole trace 1% of the time.
	 */
	test('two samplers at the same ratio agree on every trace', () => {
		const one = ratioSampler(0.1);
		const other = ratioSampler(0.1);

		for (let i = 0; i < 500; i++) {
			const traceId = randomTraceId();
			expect(one.sample(traceId)).toBe(other.sample(traceId));
		}
	});

	test('the same sampler answers the same way twice', () => {
		const sampler = ratioSampler(0.5);
		const traceId = randomTraceId();
		expect(sampler.sample(traceId)).toBe(sampler.sample(traceId));
	});

	test('keeps roughly the fraction asked for', () => {
		const sampler = ratioSampler(0.25);
		const kept = Array.from({ length: 4_000 }, () => randomTraceId()).filter(
			(traceId) => sampler.sample(traceId),
		).length;

		expect(kept / 4_000).toBeGreaterThan(0.2);
		expect(kept / 4_000).toBeLessThan(0.3);
	});

	test('decides on the low 64 bits, so the high half does not matter', () => {
		const sampler = ratioSampler(0.5);
		const low = 'ffffffffffffffff';
		const one = `00000000000000000000000000000000`.slice(0, 16) + low;
		const other = `ffffffffffffffff${low}`;

		expect(sampler.sample(one as TraceId)).toBe(
			sampler.sample(other as TraceId),
		);
	});

	test('an invalid trace id is not sampled, rather than throwing', () => {
		expect(ratioSampler(0.5).sample('not-a-trace-id' as TraceId)).toBe(false);
	});
});
