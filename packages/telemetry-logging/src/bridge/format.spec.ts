import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import {
	createTelemetry,
	span,
	withAttributes,
	withTelemetry,
} from '@nxgt/telemetry';
import winston from 'winston';
import { telemetryFormat } from './format';

/** A logger that renders to JSON, which is what the format runs before. */
function logging(format = telemetryFormat()) {
	const written: Record<string, unknown>[] = [];

	const logger = winston.createLogger({
		level: 'silly',
		format: winston.format.combine(format, winston.format.json()),
		transports: [
			new winston.transports.Stream({
				stream: new Writable({
					write(chunk: unknown, _encoding, next): void {
						written.push(JSON.parse(String(chunk)));
						next();
					},
				}),
			}),
		],
	});

	return { logger, written };
}

const telemetry = createTelemetry('checkout', { batch: 1 });

describe('telemetryFormat', () => {
	test('puts the current traceId and spanId on the line', async () => {
		const { logger, written } = logging();

		await withTelemetry(telemetry, () =>
			span('charge', {}, async () => {
				logger.info('charged');
			}),
		);
		await settled();

		expect(written[0]?.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(written[0]?.spanId).toMatch(/^[0-9a-f]{16}$/);
	});

	/**
	 * A field that is present and empty is one a dashboard has to filter out.
	 */
	test('adds nothing at all outside every span', async () => {
		const { logger, written } = logging();

		logger.info('booting');
		await settled();

		expect(written[0]).not.toHaveProperty('traceId');
		expect(written[0]).not.toHaveProperty('spanId');
	});

	test('the field names can be chosen, for a schema already in use', async () => {
		const { logger, written } = logging(
			telemetryFormat({ traceField: 'trace_id', spanField: 'span_id' }),
		);

		await withTelemetry(telemetry, () =>
			span('charge', {}, async () => {
				logger.info('charged');
			}),
		);
		await settled();

		expect(written[0]).toHaveProperty('trace_id');
		expect(written[0]).not.toHaveProperty('traceId');
	});

	test('copies the attributes in scope onto the line', async () => {
		const { logger, written } = logging();

		await withTelemetry(telemetry, () =>
			withAttributes({ tenant: 'acme' }, async () => {
				logger.info('charged');
			}),
		);
		await settled();

		expect(written[0]?.tenant).toBe('acme');
	});

	test('the attributes can be turned off', async () => {
		const { logger, written } = logging(telemetryFormat({ attributes: false }));

		await withTelemetry(telemetry, () =>
			withAttributes({ tenant: 'acme' }, async () => {
				logger.info('charged');
			}),
		);
		await settled();

		expect(written[0]).not.toHaveProperty('tenant');
	});

	/**
	 * A line that says `orderId: 'o-1'` means that order, and an ambient
	 * attribute of the same name replacing it would be a lie told quietly.
	 */
	test('an ambient attribute never replaces a field the caller set', async () => {
		const { logger, written } = logging();

		await withTelemetry(telemetry, () =>
			withAttributes({ orderId: 'from the scope' }, async () => {
				logger.info('charged', { orderId: 'from the call' });
			}),
		);
		await settled();

		expect(written[0]?.orderId).toBe('from the call');
	});

	test('a line keeps everything it already had', async () => {
		const { logger, written } = logging();

		await withTelemetry(telemetry, () =>
			span('charge', {}, async () => {
				logger.warn('careful', { orderId: 'o-1' });
			}),
		);
		await settled();

		expect(written[0]).toMatchObject({
			level: 'warn',
			message: 'careful',
			orderId: 'o-1',
		});
	});

	/**
	 * A format runs on the way to every transport, on every line. It cannot be
	 * the reason a line is lost.
	 */
	test('a transform that cannot read the context still returns the line', () => {
		const format = telemetryFormat();
		const info = { level: 'info', message: 'still here' };

		expect(format.transform(info)).toBe(info);
	});

	/** `combine(...)` calls `transform(info, options)` and nothing else. */
	test('is the shape winston consumes, without importing winston', () => {
		const format = telemetryFormat();

		expect(typeof format.transform).toBe('function');
		expect(format.options).toEqual({});
		expect(winston.format.combine(format, winston.format.json())).toBeDefined();
	});
});

function settled(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 10));
}
