import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import {
	createTelemetry,
	type Exporter,
	type LogRecord,
	type Resource,
	type Signal,
	span,
	type Telemetry,
	withAttributes,
	withTelemetry,
} from '@nxgt/telemetry';
import winston from 'winston';
import TransportStream from 'winston-transport';
import { type LogInfo, telemetryFormat } from './format';
import { FROM_TELEMETRY } from './origin';
import { TelemetryTransport, telemetryTransport } from './transport';

let collected: Signal[] = [];
let telemetry: Telemetry;

function collecting(): Exporter {
	return {
		export(_resource: Resource, batch: readonly Signal[]): void {
			collected.push(...batch);
		},
	};
}

/** A second transport, so a spec can see that winston still wrote the line. */
function capturing(into: unknown[]): Writable {
	return new Writable({
		write(chunk: unknown, _encoding, next): void {
			into.push(String(chunk));
			next();
		},
	});
}

function logs(): LogRecord[] {
	return collected.filter((one): one is LogRecord => one.type === 'log');
}

/** A real winston logger, writing only to this transport. */
function logging(transport = telemetryTransport({ telemetry })) {
	return winston.createLogger({
		level: 'silly',
		transports: [transport],
	});
}

beforeEach(() => {
	collected = [];
	telemetry = createTelemetry('checkout', {
		exporters: [collecting()],
		batch: 1,
		minimum: 'debug',
	});
});

afterEach(async () => {
	await telemetry.close();
});

describe('a winston line', () => {
	test('becomes a log record with its message and its level', async () => {
		logging().warn('disk is filling up');
		await telemetry.close();

		expect(logs()[0]).toMatchObject({
			type: 'log',
			severity: 'warn',
			name: 'disk is filling up',
			source: 'winston',
		});
	});

	test('carries everything else the caller put on it, as attributes', async () => {
		logging().info('order stored', { orderId: 'o-1', attempt: 2 });
		await telemetry.close();

		expect(logs()[0]?.attributes).toMatchObject({
			orderId: 'o-1',
			attempt: 2,
		});
	});

	/** `level` and `message` become the record; they are not also attributes. */
	test('does not repeat the level and the message in its attributes', async () => {
		logging().info('order stored');
		await telemetry.close();

		expect(logs()[0]?.attributes).not.toHaveProperty('level');
		expect(logs()[0]?.attributes).not.toHaveProperty('message');
	});

	test('the source can be named, for a logger that is one component', async () => {
		logging(telemetryTransport({ telemetry, source: 'CheckoutService' })).info(
			'x',
		);
		await telemetry.close();

		expect(logs()[0]?.source).toBe('CheckoutService');
	});

	/**
	 * winston takes anything as a message. A log record's name is the thing a
	 * human reads first, so it is rendered rather than left as an object.
	 */
	test('a message that is not a string is still a readable name', async () => {
		const logger = logging();
		logger.info({ message: { orderId: 'o-1' } } as never);
		await telemetry.close();

		expect(typeof logs()[0]?.name).toBe('string');
		expect(logs()[0]?.name).toContain('o-1');
	});
});

describe('where the line hangs', () => {
	test('a line written inside a span carries that span', async () => {
		const logger = logging();

		await withTelemetry(telemetry, () =>
			span('GET /orders/:id', { kind: 'server' }, async () => {
				logger.info('order stored');
			}),
		);
		await telemetry.close();

		const request = collected.find((one) => one.type === 'span');
		expect(logs()[0]?.span?.spanId).toBe(
			request?.type === 'span' ? request.context.spanId : undefined,
		);
	});

	test('a line written outside every span carries none', async () => {
		logging().info('booting');
		await telemetry.close();

		expect(logs()[0]?.span).toBeUndefined();
	});

	/**
	 * The transport resolves the telemetry the same way a `log.*` call does:
	 * the one in scope first, the installed one otherwise.
	 */
	test('with no telemetry anywhere it is inert, and winston still writes', async () => {
		const written: unknown[] = [];
		const logger = winston.createLogger({
			level: 'silly',
			transports: [
				telemetryTransport(),
				new winston.transports.Stream({ stream: capturing(written) }),
			],
		});

		logger.info('booting');
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(collected).toHaveLength(0);
		expect(written).toHaveLength(1);
	});
});

describe('what winston makes of it', () => {
	/**
	 * winston wraps a transport it does not recognise in a `LegacyTransportStream`
	 * and prints a deprecation notice. What it checks is a writable stream in
	 * object mode whose `log` takes two arguments — which is why this extends
	 * `node:stream`'s `Writable` and not `winston-transport`.
	 */
	test('is used directly, not wrapped as a legacy transport', () => {
		const transport = telemetryTransport({ telemetry });
		const logger = logging(transport);

		expect(logger.transports[0]).toBe(transport);
		expect(transport.log.length).toBe(2);
	});

	test('is a writable stream in object mode, which winston requires', () => {
		const transport = telemetryTransport({ telemetry });

		expect(transport.writable).toBe(true);
		expect(
			(transport as unknown as { _writableState: { objectMode: boolean } })
				._writableState.objectMode,
		).toBe(true);
	});

	/** `level` is winston's own option, and winston is what enforces it. */
	test('winston honours a level set on the transport', async () => {
		const logger = winston.createLogger({
			level: 'silly',
			transports: [telemetryTransport({ telemetry, level: 'warn' })],
		});

		logger.info('quiet');
		logger.error('loud');
		await telemetry.close();

		expect(logs().map((one) => one.name)).toEqual(['loud']);
	});

	test('reads a level the logger colourised on the way past', async () => {
		winston.addColors(winston.config.npm.colors);
		const logger = winston.createLogger({
			level: 'silly',
			format: winston.format.colorize({ all: true }),
			transports: [telemetryTransport({ telemetry })],
		});

		logger.warn('careful');
		await telemetry.close();

		expect(logs()[0]?.severity).toBe('warn');
	});

	/** The format puts them there; the transport must not lose them. */
	test('keeps the ids telemetryFormat added', async () => {
		const logger = winston.createLogger({
			level: 'silly',
			format: telemetryFormat(),
			transports: [telemetryTransport({ telemetry })],
		});

		await withTelemetry(telemetry, () =>
			span('charge', {}, async () => {
				logger.info('charged');
			}),
		);
		await telemetry.close();

		expect(logs()[0]?.attributes.traceId).toBe(
			logs()[0]?.span?.traceId as string,
		);
	});
});

describe('the loop', () => {
	/**
	 * A line this library wrote *into* winston, coming back round. Posting it
	 * would be an infinite loop that looks like a busy service — which is why
	 * the mark is a plain field and survives everything winston does to a line.
	 */
	test('a line marked as this library’s own is not posted back', async () => {
		logging().info('charged', { [FROM_TELEMETRY]: true, orderId: 'o-1' });
		await telemetry.close();

		expect(logs()).toHaveLength(0);
	});

	test('a line that merely mentions the mark as text is posted', async () => {
		logging().info('charged', { [FROM_TELEMETRY]: 'yes' });
		await telemetry.close();

		expect(logs()).toHaveLength(1);
	});
});

describe('when something goes wrong', () => {
	/**
	 * A transport that throws takes the line down for every *other* transport
	 * on the same logger.
	 */
	test('a telemetry that throws costs neither the line nor the process', async () => {
		const hostile = {
			emit(): boolean {
				throw new Error('the pipeline is broken');
			},
		} as unknown as Telemetry;
		const written: unknown[] = [];

		const logger = winston.createLogger({
			level: 'silly',
			transports: [
				telemetryTransport({ telemetry: hostile }),
				new winston.transports.Stream({ stream: capturing(written) }),
			],
		});

		expect(() => logger.info('still written')).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(written).toHaveLength(1);
	});

	test('the class and the function build the same thing', () => {
		expect(telemetryTransport()).toBeInstanceOf(TelemetryTransport);
	});
});

describe('what a line is about', () => {
	/**
	 * `@nxgt/telemetry-otlp` turns a record's `error` into `exception.type`,
	 * `exception.message` and `exception.stacktrace` — the fields an exception
	 * dashboard queries on. Left as text on an attribute, a winston error line
	 * has none of them.
	 */
	test('an Error as the message becomes an ErrorInfo', async () => {
		logging().error(new Error('card refused'));
		await telemetry.close();

		expect(logs()[0]?.error).toMatchObject({
			type: 'Error',
			message: 'card refused',
		});
		expect(logs()[0]?.error?.stackTrace).toContain('Error: card refused');
	});

	test('an Error passed as meta becomes one too', async () => {
		logging().error('charge failed', { error: new TypeError('bad card') });
		await telemetry.close();

		expect(logs()[0]?.error).toMatchObject({
			type: 'TypeError',
			message: 'bad card',
		});
	});

	/**
	 * `format.errors()` flattens the error onto the line and keeps only the
	 * stack, which is all there is left to rebuild from.
	 */
	test('a stack left by format.errors() is rebuilt into one', async () => {
		const logger = winston.createLogger({
			level: 'silly',
			format: winston.format.errors({ stack: true }),
			transports: [telemetryTransport({ telemetry })],
		});

		logger.error(new RangeError('out of range'));
		await telemetry.close();

		expect(logs()[0]?.error?.type).toBe('RangeError');
		expect(logs()[0]?.error?.stackTrace).toContain('RangeError');
		expect(logs()[0]?.attributes).not.toHaveProperty('stack');
	});

	test('an ordinary line is about no failure at all', async () => {
		logging().info('order stored');
		await telemetry.close();

		expect(logs()[0]?.error).toBeUndefined();
	});

	/**
	 * The inheritance rule the rest of the library follows: what `span()` and
	 * `withAttributes()` were given reaches the logs nested inside.
	 */
	test('carries the attributes in scope', async () => {
		const logger = logging();

		await withTelemetry(telemetry, () =>
			withAttributes({ tenant: 'acme' }, async () => {
				logger.info('order stored');
			}),
		);
		await telemetry.close();

		expect(logs()[0]?.attributes.tenant).toBe('acme');
	});

	/** A field the call site set means what it says. */
	test('a scope attribute never replaces one the line carried', async () => {
		const logger = logging();

		await withTelemetry(telemetry, () =>
			withAttributes({ orderId: 'from the scope' }, async () => {
				logger.info('order stored', { orderId: 'from the call' });
			}),
		);
		await telemetry.close();

		expect(logs()[0]?.attributes.orderId).toBe('from the call');
	});
});

describe('the floors it clears', () => {
	/**
	 * winston has already applied its own level. This is the telemetry's, and a
	 * service that set `minimum: 'error'` means it for every route into the
	 * pipeline — which is also what makes the `info` fallback in `levels.ts` the
	 * safe direction to err in.
	 */
	test('a line below the telemetry minimum is not posted', async () => {
		const quiet = createTelemetry('checkout', {
			exporters: [collecting()],
			batch: 1,
			minimum: 'error',
		});
		const logger = winston.createLogger({
			level: 'silly',
			transports: [telemetryTransport({ telemetry: quiet })],
		});

		logger.debug('chatter');
		logger.error('refused');
		await quiet.close();

		expect(logs().map((one) => one.name)).toEqual(['refused']);
	});

	/**
	 * winston pipes every line to every transport and expects each one to
	 * filter, which is why this reimplements what `winston-transport` does. The
	 * spec is against the real thing: both transports see the same lines and
	 * must keep the same ones.
	 */
	test('filters exactly as a real winston-transport does', async () => {
		const kept: string[] = [];

		class Reference extends TransportStream {
			override log(info: LogInfo, next: () => void): void {
				kept.push(String(info.level));
				next();
			}
		}

		const logger = winston.createLogger({
			level: 'silly',
			transports: [
				telemetryTransport({ telemetry, level: 'warn' }),
				new Reference({ level: 'warn' }),
			],
		});

		for (const level of ['silly', 'debug', 'info', 'warn', 'error']) {
			logger.log(level, level);
		}
		await telemetry.close();

		expect(logs().map((one) => one.name)).toEqual(kept);
		expect(kept).toEqual(['warn', 'error']);
	});

	test('a silent transport receives nothing', async () => {
		logging(telemetryTransport({ telemetry, silent: true })).error('refused');
		await telemetry.close();

		expect(logs()).toHaveLength(0);
	});

	/**
	 * Turning this on puts the transport in winston's list of exception
	 * handlers, and winston then waits up to three seconds for each of them to
	 * finish before the process exits. Off is winston's own default.
	 */
	test('a line from winston\u2019s exceptionHandlers is skipped by default', async () => {
		logging().log({ level: 'error', message: 'uncaught', exception: true });
		await telemetry.close();

		expect(logs()).toHaveLength(0);
	});

	test('and collected when handleExceptions is asked for', async () => {
		logging(telemetryTransport({ telemetry, handleExceptions: true })).log({
			level: 'error',
			message: 'uncaught',
			exception: true,
		});
		await telemetry.close();

		expect(logs()).toHaveLength(1);
	});

	/**
	 * `winston-transport` compares against `undefined` here, which is `false`,
	 * and drops the line. This keeps it: a level nobody declared is somebody's
	 * mistake, and losing the line is how the mistake stays invisible.
	 */
	test('a line at a level the table does not know is kept', async () => {
		const transport = telemetryTransport({ telemetry, level: 'warn' });
		const logger = logging(transport);

		logger.log({ level: 'crit', message: 'something odd' });
		await telemetry.close();

		expect(logs().map((one) => one.name)).toEqual(['something odd']);
	});

	/** Left pointing at the old logger, `parent` filters by nobody's level. */
	test('forgets its logger when it is removed', () => {
		const transport = telemetryTransport({ telemetry });
		const logger = logging(transport);

		expect(transport.parent).toBeDefined();
		logger.remove(transport);
		expect(transport.parent).toBeUndefined();
	});
});
