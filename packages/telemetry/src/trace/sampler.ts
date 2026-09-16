import { isValidTraceId, type TraceId } from './ids';

/**
 * Sampling is decided once, by the root span, and the answer travels with the
 * trace — down through every child and out over the wire in the `traceparent`.
 * A sampler consulted per span produces traces missing their middles, and a gap
 * in a trace looks like work that never happened.
 *
 * Logs are not sampled. That decision is about the volume of traces, and a log
 * dropped because its trace was not kept is a log missing at precisely the
 * moment somebody is reading logs to find out what happened.
 */
export interface Sampler {
	sample(traceId: TraceId): boolean;
}

export const alwaysSample: Sampler = { sample: () => true };

export const neverSample: Sampler = { sample: () => false };

const MAX_UINT64 = (1n << 64n) - 1n;
const SCALE = 1n << 53n;

/**
 * Keep this fraction of traces, decided **from the trace id** rather than by a
 * coin toss: two services at the same ratio then make the same decision about
 * the same trace. Two services tossing independently at 10% keep a whole trace
 * 1% of the time.
 *
 * The rule is OpenTelemetry's — the low 64 bits of the trace id against
 * `ratio × 2⁶⁴` — so anything else implementing it agrees with us.
 *
 * @throws RangeError if `ratio` is not between 0 and 1. This is a construction
 * error, raised where the mistake is, and never on the path that writes a
 * signal.
 */
export function ratioSampler(ratio: number): Sampler {
	if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
		throw new RangeError(`A sampling ratio is between 0 and 1, not ${ratio}`);
	}
	if (ratio === 0) return neverSample;
	if (ratio === 1) return alwaysSample;

	const threshold =
		(BigInt(Math.round(ratio * Number(SCALE))) * MAX_UINT64) / SCALE;

	return {
		sample(traceId: TraceId): boolean {
			if (!isValidTraceId(traceId)) return false;
			return BigInt(`0x${traceId.slice(-16)}`) < threshold;
		},
	};
}
