import { afterEach, describe, expect, test } from 'bun:test';
import { currentSpan, withTelemetry } from '../context/current';
import type { Exporter } from '../export/exporter';
import type { Signal, SpanRecord } from '../model/signal';
import {
	createTelemetry,
	type Telemetry,
	uninstallTelemetry,
} from '../telemetry/telemetry';
import { parseTraceparent, randomSpanId, randomTraceId } from '../trace/ids';
import { alwaysSample, neverSample, ratioSampler } from '../trace/sampler';
import { continuing, span } from './span';

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

	const spans = async (): Promise<SpanRecord[]> => {
		await telemetry.close();
		return signals.filter((s): s is SpanRecord => s.type === 'span');
	};

	return { telemetry, signals, spans };
}

async function within<T>(
	telemetry: Telemetry,
	fn: () => Promise<T>,
): Promise<T> {
	return withTelemetry(telemetry, fn);
}

describe('with no telemetry anywhere', () => {
	test('the block still runs, and nothing is emitted', async () => {
		let ran = false;
		const answer = await span('charge', async (scope) => {
			ran = true;
			expect(scope.traceId).toBe('0'.repeat(32) as typeof scope.traceId);
			return 42;
		});

		expect(ran).toBe(true);
		expect(answer).toBe(42);
	});
});

describe('a root span', () => {
	test('is emitted with its name, kind, timing and no parent', async () => {
		const { telemetry, spans } = collecting();

		await within(telemetry, () => span('charge', async () => {}));

		const [record] = await spans();
		expect(record?.name).toBe('charge');
		expect(record?.kind).toBe('internal');
		expect(record?.parent).toBeUndefined();
		expect(record?.status).toBe('ok');
		expect(record?.endedAt).toBeGreaterThanOrEqual(record?.startedAt ?? 0);
	});

	test('takes the kind it was given', async () => {
		const { telemetry, spans } = collecting();

		await within(telemetry, () =>
			span('GET /orders', { kind: 'server' }, async () => {}),
		);

		expect((await spans())[0]?.kind).toBe('server');
	});

	test('can be renamed from inside, which is what routing needs', async () => {
		const { telemetry, spans } = collecting();

		await within(telemetry, () =>
			span('GET /orders/o-1', async (scope) => {
				scope.name = 'GET /orders/{id}';
				scope.attribute('http.route', '/orders/{id}');
			}),
		);

		const [record] = await spans();
		expect(record?.name).toBe('GET /orders/{id}');
		expect(record?.attributes['http.route']).toBe('/orders/{id}');
	});
});

/**
 * The chain is the thing. A header that round-trips proves nothing: what a
 * backend draws is `parentSpanId`, and a trace whose children have no parent is
 * a list, not a trace.
 */
describe('nesting', () => {
	test('a child carries the trace of its parent and points at it', async () => {
		const { telemetry, spans } = collecting();

		await within(telemetry, () =>
			span('outer', async (outer) => {
				await span('inner', async (inner) => {
					expect(inner.traceId).toBe(outer.traceId);
					expect(inner.spanId).not.toBe(outer.spanId);
				});
			}),
		);

		const records = await spans();
		const inner = records.find((r) => r.name === 'inner');
		const outer = records.find((r) => r.name === 'outer');

		expect(inner?.context.traceId).toBe(outer?.context.traceId);
		expect(inner?.parent).toBe(outer?.context.spanId);
		expect(outer?.parent).toBeUndefined();
	});

	test('the inner span is the current one while it is open', async () => {
		const { telemetry } = collecting();

		await within(telemetry, () =>
			span('outer', async (outer) => {
				await span('inner', async (inner) => {
					expect(currentSpan()?.spanId).toBe(inner.spanId);
				});
				expect(currentSpan()?.spanId).toBe(outer.spanId);
			}),
		);
	});

	test('attributes given to a span are inherited by the spans inside it', async () => {
		const { telemetry, spans } = collecting();

		await within(telemetry, () =>
			span('outer', { attributes: { tenant: 'acme' } }, async () => {
				await span('inner', { attributes: { orderId: 'o-1' } }, async () => {});
			}),
		);

		const inner = (await spans()).find((r) => r.name === 'inner');
		expect(inner?.attributes).toEqual({ tenant: 'acme', orderId: 'o-1' });
	});

	test('an attribute set on a scope belongs to that span alone', async () => {
		const { telemetry, spans } = collecting();

		await within(telemetry, () =>
			span('outer', async (outer) => {
				outer.attribute('mine', true);
				await span('inner', async () => {});
			}),
		);

		const records = await spans();
		expect(records.find((r) => r.name === 'inner')?.attributes).toEqual({});
		expect(records.find((r) => r.name === 'outer')?.attributes).toEqual({
			mine: true,
		});
	});
});

describe('failure', () => {
	test('is recorded and rethrown — a span observes, it does not handle', async () => {
		const { telemetry, spans } = collecting();

		await expect(
			within(telemetry, () =>
				span('charge', async () => {
					throw new RangeError('no funds');
				}),
			),
		).rejects.toThrow('no funds');

		const [record] = await spans();
		expect(record?.status).toBe('error');
		expect(record?.error?.type).toBe('RangeError');
		expect(record?.error?.message).toBe('no funds');
		expect(record?.error?.stackTrace).toContain('RangeError');
	});

	test('an abort is cancelled, not an error, and carries no stack', async () => {
		const { telemetry, spans } = collecting();
		const aborted = new Error('the caller went away');
		aborted.name = 'AbortError';

		await expect(
			within(telemetry, () =>
				span('charge', async () => {
					throw aborted;
				}),
			),
		).rejects.toThrow();

		const [record] = await spans();
		expect(record?.status).toBe('cancelled');
		expect(record?.error?.stackTrace).toBeUndefined();
	});

	test('a thrown string is recorded rather than refused', async () => {
		const { telemetry, spans } = collecting();

		await expect(
			// biome-ignore lint/complexity/useLiteralKeys: throwing a non-Error on purpose
			within(telemetry, () =>
				span('charge', async () => {
					throw 'no';
				}),
			),
		).rejects.toBe('no');

		expect((await spans())[0]?.error?.type).toBe('string');
	});

	test('stackTraces: false keeps the type and drops the trace', async () => {
		const { telemetry, spans } = collecting({ stackTraces: false });

		await expect(
			within(telemetry, () =>
				span('charge', async () => {
					throw new Error('no');
				}),
			),
		).rejects.toThrow();

		const [record] = await spans();
		expect(record?.error?.type).toBe('Error');
		expect(record?.error?.stackTrace).toBeUndefined();
	});

	test('a status set by hand is kept when nothing threw', async () => {
		const { telemetry, spans } = collecting();

		await within(telemetry, () =>
			span('charge', async (scope) => {
				scope.status = 'error';
			}),
		);

		expect((await spans())[0]?.status).toBe('error');
	});
});

describe('events on a span', () => {
	test('are recorded in order, with their attributes', async () => {
		const { telemetry, spans } = collecting();

		await within(telemetry, () =>
			span('charge', async (scope) => {
				scope.event('gateway.called', { attempt: 1 });
				scope.event('gateway.answered');
			}),
		);

		const [record] = await spans();
		expect(record?.events.map((e) => e.name)).toEqual([
			'gateway.called',
			'gateway.answered',
		]);
		expect(record?.events[0]?.attributes).toEqual({ attempt: 1 });
	});
});

/**
 * Decision 4: the sampler is asked once, by the root. A sampler consulted per
 * span produces traces missing their middles, and a gap in a trace looks like
 * work that never happened.
 */
describe('sampling', () => {
	test('is asked once, by the root, however deep the trace goes', async () => {
		let asked = 0;
		const { telemetry } = collecting({
			sampler: {
				sample: () => {
					asked++;
					return true;
				},
			},
		});

		await within(telemetry, () =>
			span('a', async () => {
				await span('b', async () => {
					await span('c', async () => {});
				});
			}),
		);

		await telemetry.close();
		expect(asked).toBe(1);
	});

	test('an unsampled trace emits no span at all', async () => {
		const { telemetry, spans } = collecting({ sampler: neverSample });

		await within(telemetry, () => span('charge', async () => {}));

		expect(await spans()).toEqual([]);
	});

	test('but the block still runs, and the context is still there', async () => {
		const { telemetry } = collecting({ sampler: neverSample });
		let seen: string | undefined;

		await within(telemetry, () =>
			span('charge', async (scope) => {
				seen = currentSpan()?.spanId;
				expect(scope.traceparent()).toEndWith('-00');
			}),
		);

		expect(seen).toBeDefined();
	});

	test('a sampler that throws does not fail the request', async () => {
		const { telemetry, spans } = collecting({
			sampler: {
				sample: () => {
					throw new Error('broken sampler');
				},
			},
		});

		await within(telemetry, () => span('charge', async () => {}));

		expect(await spans()).toEqual([]);
	});

	test('the decision is inherited, not retaken, so a ratio cannot split a trace', async () => {
		const { telemetry, spans } = collecting({ sampler: ratioSampler(0.5) });

		for (let i = 0; i < 40; i++) {
			await within(telemetry, () =>
				span('outer', async () => {
					await span('inner', async () => {});
				}),
			);
		}

		const records = await spans();
		const traces = new Map<string, number>();
		for (const record of records) {
			traces.set(
				record.context.traceId,
				(traces.get(record.context.traceId) ?? 0) + 1,
			);
		}

		// Every kept trace kept both of its spans; none kept only the outer.
		expect([...traces.values()].every((count) => count === 2)).toBe(true);
	});
});

describe('continuing an inbound trace', () => {
	test('adopts the caller trace and points at the caller span', async () => {
		const { telemetry, spans } = collecting();
		const caller = { traceId: randomTraceId(), spanId: randomSpanId() };
		const header = `00-${caller.traceId}-${caller.spanId}-01`;

		await within(telemetry, () =>
			continuing(header, 'GET /orders', async () => {}),
		);

		const [record] = await spans();
		expect(record?.context.traceId).toBe(caller.traceId);
		expect(record?.parent).toBe(caller.spanId);
		expect(record?.kind).toBe('server');
	});

	test('carries the caller decision, without asking the sampler', async () => {
		let asked = 0;
		const { telemetry, spans } = collecting({
			sampler: {
				sample: () => {
					asked++;
					return false;
				},
			},
		});
		const header = `00-${randomTraceId()}-${randomSpanId()}-01`;

		await within(telemetry, () =>
			continuing(header, 'GET /orders', async () => {}),
		);

		expect(await spans()).toHaveLength(1);
		expect(asked).toBe(0);
	});

	test('a header a stranger mangled starts a fresh trace instead of failing', async () => {
		const { telemetry, spans } = collecting();

		await within(telemetry, () =>
			continuing('nonsense', 'GET /orders', async () => {}),
		);

		const [record] = await spans();
		expect(record?.parent).toBeUndefined();
		expect(
			parseTraceparent(
				`00-${record?.context.traceId}-${record?.context.spanId}-01`,
			),
		).not.toBeNull();
	});

	test('no header at all is the same as a fresh trace', async () => {
		const { telemetry, spans } = collecting();

		await within(telemetry, () =>
			continuing(null, 'GET /orders', async () => {}),
		);

		expect((await spans())[0]?.parent).toBeUndefined();
	});

	test('the header wins over an ambient span: the caller trace is the trace', async () => {
		const { telemetry, spans } = collecting({ sampler: alwaysSample });
		const caller = { traceId: randomTraceId(), spanId: randomSpanId() };

		await within(telemetry, () =>
			span('ambient', async () => {
				await continuing(
					`00-${caller.traceId}-${caller.spanId}-01`,
					'GET /orders',
					async () => {},
				);
			}),
		);

		const inbound = (await spans()).find((r) => r.name === 'GET /orders');
		expect(inbound?.context.traceId).toBe(caller.traceId);
		expect(inbound?.parent).toBe(caller.spanId);
	});
});
