import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import {
	createLogger,
	createTelemetry,
	type Resource,
	span,
	withTelemetry,
} from '@nxgt/telemetry';
import winston from 'winston';
import { telemetryTransport } from '../bridge/transport';
import { winstonExporter } from './winston';

const RESOURCE: Resource = { service: 'checkout', attributes: {} };

interface Written {
	level: string;
	message: string;
	[field: string]: unknown;
}

/** A real winston logger, and the lines it wrote. */
function logging() {
	const written: Written[] = [];

	const logger = winston.createLogger({
		level: 'silly',
		format: winston.format.json(),
		transports: [
			new winston.transports.Stream({
				stream: new Writable({
					write(chunk: unknown, _encoding, next): void {
						written.push(JSON.parse(String(chunk)) as Written);
						next();
					},
				}),
			}),
		],
	});

	return { logger, written };
}

function settled(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('a log signal', () => {
	test('is a winston line at the matching level', async () => {
		const { logger, written } = logging();
		const telemetry = createTelemetry('checkout', {
			exporters: [winstonExporter({ logger })],
			batch: 1,
			minimum: 'debug',
		});
		const log = createLogger('CheckoutService');

		await withTelemetry(telemetry, async () => {
			log.debug('looking up');
			log.info('charged');
			log.warn('slow');
			log.error('refused');
		});
		await telemetry.close();
		await settled();

		expect(written.map((one) => one.level)).toEqual([
			'debug',
			'info',
			'warn',
			'error',
		]);
		// Write order, which the pipeline preserves and this must not reorder.
		expect(written.map((one) => one.message)).toEqual([
			'looking up',
			'charged',
			'slow',
			'refused',
		]);
	});

	test('carries its attributes, its source and its trace', async () => {
		const { logger, written } = logging();
		const telemetry = createTelemetry('checkout', {
			exporters: [winstonExporter({ logger })],
			batch: 1,
		});
		const log = createLogger('CheckoutService');

		await withTelemetry(telemetry, () =>
			span('charge', {}, async () => {
				log.info('charged', { orderId: 'o-1' });
			}),
		);
		await telemetry.close();
		await settled();

		expect(written[0]).toMatchObject({
			message: 'charged',
			source: 'CheckoutService',
			orderId: 'o-1',
		});
		expect(written[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
	});
});

describe('a span signal', () => {
	/**
	 * A span is a duration and a set of attributes, which is a poor fit for a
	 * line of text, and turning every one of them into a log line is how a
	 * cheap trace becomes an expensive log bill.
	 */
	test('is not written at all by default', async () => {
		const { logger, written } = logging();
		const telemetry = createTelemetry('checkout', {
			exporters: [winstonExporter({ logger })],
			batch: 1,
		});

		await withTelemetry(telemetry, () => span('charge', {}, async () => {}));
		await telemetry.close();
		await settled();

		expect(written).toHaveLength(0);
	});

	test('is a line with its duration and its ids when spans are on', async () => {
		const { logger, written } = logging();
		const telemetry = createTelemetry('checkout', {
			exporters: [winstonExporter({ logger, spans: true })],
			batch: 1,
		});

		await withTelemetry(telemetry, () =>
			span('charge', { kind: 'client' }, async () => {}),
		);
		await telemetry.close();
		await settled();

		expect(written[0]).toMatchObject({
			level: 'info',
			message: 'charge',
			kind: 'client',
			status: 'ok',
		});
		expect(typeof written[0]?.durationMs).toBe('number');
		expect(written[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
	});

	test('the level spans are written at can be chosen', async () => {
		const { logger, written } = logging();
		const telemetry = createTelemetry('checkout', {
			exporters: [
				winstonExporter({ logger, spans: true, spanSeverity: 'debug' }),
			],
			batch: 1,
			minimum: 'debug',
		});

		await withTelemetry(telemetry, () => span('charge', {}, async () => {}));
		await telemetry.close();
		await settled();

		expect(written[0]?.level).toBe('debug');
	});

	/** That is the line somebody is looking for. */
	test('a failed span is error, whatever spanSeverity says', async () => {
		const { logger, written } = logging();
		const telemetry = createTelemetry('checkout', {
			exporters: [
				winstonExporter({ logger, spans: true, spanSeverity: 'debug' }),
			],
			batch: 1,
			minimum: 'debug',
		});

		await withTelemetry(telemetry, () =>
			span('charge', {}, async () => {
				throw new Error('card refused');
			}).catch(() => undefined),
		);
		await telemetry.close();
		await settled();

		expect(written[0]).toMatchObject({
			level: 'error',
			status: 'error',
			'exception.type': 'Error',
			'exception.message': 'card refused',
		});
	});

	test('a child span names the parent it hangs from', async () => {
		const { logger, written } = logging();
		const telemetry = createTelemetry('checkout', {
			exporters: [winstonExporter({ logger, spans: true })],
			batch: 1,
		});

		await withTelemetry(telemetry, () =>
			span('request', { kind: 'server' }, async () => {
				await span('charge', { kind: 'client' }, async () => {});
			}),
		);
		await telemetry.close();
		await settled();

		const child = written.find((one) => one.message === 'charge');
		const parent = written.find((one) => one.message === 'request');
		expect(child?.parentSpanId).toBe(parent?.spanId);
	});
});

describe('the loop it refuses', () => {
	/**
	 * Both halves on the same logger is a loop, and a loop here does not crash:
	 * it spins, quietly, at whatever rate the process can manage.
	 */
	test('a logger that already feeds the pipeline is refused at construction', () => {
		const logger = winston.createLogger({
			transports: [telemetryTransport()],
		});

		expect(() => winstonExporter({ logger })).toThrow(/loop/);
	});

	test('a logger with ordinary transports is fine', () => {
		const { logger } = logging();

		expect(() => winstonExporter({ logger })).not.toThrow();
	});

	test('a logger with no transports at all is fine', () => {
		expect(() =>
			winstonExporter({ logger: { log: () => undefined } }),
		).not.toThrow();
	});

	/**
	 * The shape construction cannot see: two loggers pointing at each other.
	 * The mark on the line is what stops it, and this is the spec that says so
	 * — without it the process would spin rather than fail.
	 */
	test('two loggers wired at each other settle instead of spinning', async () => {
		expect(await roundTrips('charged')).toHaveLength(1);
	});

	/**
	 * winston's three-argument `log(level, message, meta)` tests the message
	 * against `/%[scdjifoO%]/` and, when it matches, treats the meta as printf
	 * arguments — so **none of it reaches the line**. A span named
	 * `GET /files/%s` would lose its ids, its attributes and the mark that stops
	 * this loop, and the process would spin. The one-argument form parses
	 * nothing.
	 */
	test('a message with a printf token keeps its mark, and does not spin', async () => {
		expect(await roundTrips('charged %s for %d')).toHaveLength(1);
	});

	test('a message with a printf token keeps its ids and attributes', async () => {
		const { logger, written } = logging();
		const telemetry = createTelemetry('checkout', {
			exporters: [winstonExporter({ logger })],
			batch: 1,
		});
		const log = createLogger('CheckoutService');

		await withTelemetry(telemetry, () =>
			span('charge', {}, async () => {
				log.info('charged %s', { orderId: 'o-1' });
			}),
		);
		await telemetry.close();
		await settled();

		expect(written[0]).toMatchObject({
			source: 'CheckoutService',
			orderId: 'o-1',
		});
		expect(written[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
	});

	/**
	 * The loop, wired the way construction cannot see: the transport is added
	 * *after* the exporter was built. What stops it is the mark on the line.
	 */
	async function roundTrips(message: string): Promise<Written[]> {
		const { logger, written } = logging();
		const telemetry = createTelemetry('checkout', {
			exporters: [winstonExporter({ logger })],
			batch: 1,
		});
		logger.add(telemetryTransport({ telemetry }));

		const log = createLogger('CheckoutService');
		await withTelemetry(telemetry, async () => {
			log.info(message);
		});
		await telemetry.close();
		await settled();

		return written.filter((one) => one.message === message);
	}
});

describe('when the logger goes wrong', () => {
	/**
	 * An exporter that throws reaches `onExportError` and costs the rest of the
	 * batch. A logger with a broken transport is not worth that.
	 */
	test('a logger that throws costs neither the batch nor the process', () => {
		const written: string[] = [];
		const exporter = winstonExporter({
			logger: {
				log(info: Record<string, unknown>): void {
					const message = String(info.message);
					if (message === 'second') throw new Error('the transport is gone');
					written.push(message);
				},
			},
		});

		expect(() =>
			exporter.export(RESOURCE, [line('first'), line('second'), line('third')]),
		).not.toThrow();
		expect(written).toEqual(['first', 'third']);
	});
});

function line(name: string) {
	return {
		type: 'log',
		at: Date.now(),
		severity: 'info',
		name,
		source: 'CheckoutService',
		attributes: {},
	} as const;
}
