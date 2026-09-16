import { afterEach, describe, expect, test } from 'bun:test';
import { EMPTY_ATTRIBUTES } from '../attributes/attributes';
import { createTelemetry, uninstallTelemetry } from '../telemetry/telemetry';
import { randomSpanId, randomTraceId, type SpanContext } from '../trace/ids';
import {
	currentAttributes,
	currentContext,
	currentSpan,
	currentTraceparent,
	resolveTelemetry,
	runWithContext,
	withAttributes,
	withTelemetry,
} from './current';

afterEach(() => uninstallTelemetry());

function span(): SpanContext {
	return {
		traceId: randomTraceId(),
		spanId: randomSpanId(),
		sampled: true,
		remote: false,
	};
}

/**
 * These are the scenarios a module-level `let current` gets wrong. Each one is
 * a bug that looks right in development and starts attributing one request's
 * work to another under concurrency — with no stack trace and no failing test,
 * in the tool meant to make such bugs visible.
 */
describe('the current context', () => {
	const telemetry = createTelemetry('checkout');

	test('is absent outside everything', () => {
		expect(currentContext()).toBeUndefined();
		expect(currentSpan()).toBeUndefined();
		expect(currentTraceparent()).toBeUndefined();
		expect(currentAttributes()).toBe(EMPTY_ATTRIBUTES);
	});

	test('survives fifty suspensions', async () => {
		const mine = span();

		await runWithContext(
			{ telemetry, span: mine, attributes: EMPTY_ATTRIBUTES },
			async () => {
				for (let i = 0; i < 50; i++) {
					await Bun.sleep(0);
					expect(currentSpan()?.spanId).toBe(mine.spanId);
				}
			},
		);

		expect(currentSpan()).toBeUndefined();
	});

	test('two sibling tasks cannot see each other', async () => {
		const one = span();
		const other = span();
		const seen: (string | undefined)[] = [];

		const task = (mine: SpanContext) =>
			runWithContext(
				{ telemetry, span: mine, attributes: EMPTY_ATTRIBUTES },
				async () => {
					await Bun.sleep(5);
					seen.push(currentSpan()?.spanId);
				},
			);

		await Promise.all([task(one), task(other)]);

		expect(new Set(seen)).toEqual(new Set([one.spanId, other.spanId]));
	});

	test('travels into a timer started inside it', async () => {
		const mine = span();

		const seen = await runWithContext(
			{ telemetry, span: mine, attributes: EMPTY_ATTRIBUTES },
			() =>
				new Promise<string | undefined>((resolve) => {
					setTimeout(() => resolve(currentSpan()?.spanId), 1);
				}),
		);

		expect(seen).toBe(mine.spanId);
	});

	test('does not leak out of a task that threw', async () => {
		await expect(
			runWithContext(
				{ telemetry, span: span(), attributes: EMPTY_ATTRIBUTES },
				async () => {
					throw new Error('no');
				},
			),
		).rejects.toThrow('no');

		expect(currentSpan()).toBeUndefined();
	});

	test('renders the header an outgoing call should carry', () => {
		const mine = span();
		runWithContext(
			{ telemetry, span: mine, attributes: EMPTY_ATTRIBUTES },
			() => {
				expect(currentTraceparent()).toBe(
					`00-${mine.traceId}-${mine.spanId}-01`,
				);
			},
		);
	});
});

describe('resolveTelemetry', () => {
	test('finds nothing when nothing is installed', () => {
		expect(resolveTelemetry()).toBeUndefined();
	});

	test('finds the installed one', () => {
		const telemetry = createTelemetry('checkout').install();
		expect(resolveTelemetry()).toBe(telemetry);
	});

	/**
	 * Scope first, installed second. That order is what lets two suites in one
	 * process each collect their own signals.
	 */
	test('prefers the one in scope', () => {
		const installed = createTelemetry('checkout').install();
		const scoped = createTelemetry('checkout-under-test');

		withTelemetry(scoped, () => {
			expect(resolveTelemetry()).toBe(scoped);
		});

		expect(resolveTelemetry()).toBe(installed);
	});

	test('withTelemetry keeps the span and the attributes it found', () => {
		const telemetry = createTelemetry('checkout');
		const other = createTelemetry('other');
		const mine = span();

		runWithContext(
			{ telemetry, span: mine, attributes: { tenant: 'acme' } },
			() => {
				withTelemetry(other, () => {
					expect(currentSpan()?.spanId).toBe(mine.spanId);
					expect(currentAttributes()).toEqual({ tenant: 'acme' });
				});
			},
		);
	});
});

describe('withAttributes', () => {
	const telemetry = createTelemetry('checkout');

	test('is inherited by everything inside, and merges innermost-wins', () => {
		runWithContext({ telemetry, attributes: { tenant: 'acme' } }, () => {
			withAttributes({ tenant: 'other', orderId: 'o-1' }, () => {
				expect(currentAttributes()).toEqual({
					tenant: 'other',
					orderId: 'o-1',
				});
			});

			expect(currentAttributes()).toEqual({ tenant: 'acme' });
		});
	});

	test('coerces what it is given', () => {
		runWithContext({ telemetry, attributes: EMPTY_ATTRIBUTES }, () => {
			withAttributes({ at: new Date(0), skip: undefined }, () => {
				expect(currentAttributes()).toEqual({ at: '1970-01-01T00:00:00.000Z' });
			});
		});
	});

	test('with nothing installed at all, it runs the block unchanged', () => {
		expect(withAttributes({ tenant: 'acme' }, () => 'ran')).toBe('ran');
		expect(currentAttributes()).toBe(EMPTY_ATTRIBUTES);
	});

	/**
	 * The top level of an application, before any span has opened: there is no
	 * context to extend, but there is a telemetry to write to, so the logs
	 * written here must carry these attributes rather than silently lose them.
	 */
	test('with a telemetry installed and no span yet, it opens a context', () => {
		const installed = createTelemetry('checkout').install();

		withAttributes({ tenant: 'acme' }, () => {
			expect(currentAttributes()).toEqual({ tenant: 'acme' });
			expect(currentContext()?.telemetry).toBe(installed);
			expect(currentSpan()).toBeUndefined();
		});

		expect(currentAttributes()).toBe(EMPTY_ATTRIBUTES);
	});
});
