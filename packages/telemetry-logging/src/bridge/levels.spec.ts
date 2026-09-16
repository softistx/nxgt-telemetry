import { describe, expect, test } from 'bun:test';
import winston from 'winston';
import {
	LEVEL_OF_SEVERITY,
	levelOf,
	SEVERITY_OF_LEVEL,
	severityOf,
} from './levels';

winston.addColors(winston.config.npm.colors);

describe('severityOf', () => {
	test('maps every npm level winston ships with', () => {
		expect(severityOf('error')).toBe('error');
		expect(severityOf('warn')).toBe('warn');
		expect(severityOf('info')).toBe('info');
		expect(severityOf('http')).toBe('info');
		expect(severityOf('verbose')).toBe('debug');
		expect(severityOf('debug')).toBe('debug');
		expect(severityOf('silly')).toBe('debug');
	});

	/**
	 * Every npm level, taken from winston itself rather than from a list
	 * written here — a level added to the set upstream would otherwise fall
	 * through to the default with nothing to notice it.
	 */
	test('knows every level winston actually defines', () => {
		expect(Object.keys(SEVERITY_OF_LEVEL).sort()).toEqual(
			Object.keys(winston.config.npm.levels).sort(),
		);
	});

	/**
	 * A custom level mapped down to `debug` would be dropped by a pipeline with
	 * the default `minimum`, and a line that disappears is worse than one
	 * recorded a shade too loudly.
	 */
	test('a level it does not know is info, not debug', () => {
		expect(severityOf('crit')).toBe('info');
		expect(severityOf('emerg')).toBe('info');
		expect(severityOf('notice')).toBe('info');
	});

	test('the fallback can be chosen', () => {
		expect(severityOf('crit', 'error')).toBe('error');
	});

	/** A logger that colourises before this transport is a normal setup. */
	test('reads a level winston has already colourised', () => {
		const colorize = winston.format.colorize();
		const coloured = colorize.transform(
			{ level: 'warn', message: 'careful', [Symbol.for('level')]: 'warn' },
			{ all: true },
		);

		const level = (coloured as { level: string }).level;
		expect(level).not.toBe('warn');
		expect(severityOf(level)).toBe('warn');
	});

	test('is not case-sensitive, and ignores surrounding space', () => {
		expect(severityOf(' WARN ')).toBe('warn');
	});

	test('a level that is not a string at all is the fallback', () => {
		expect(severityOf(undefined as never)).toBe('info');
		expect(severityOf(42 as never, 'debug')).toBe('debug');
	});
});

describe('levelOf', () => {
	test('is a level winston accepts, for every severity', () => {
		const known = Object.keys(winston.config.npm.levels);

		for (const severity of Object.keys(LEVEL_OF_SEVERITY)) {
			expect(known).toContain(levelOf(severity as never));
		}
	});

	test('round-trips the four severities', () => {
		for (const severity of ['debug', 'info', 'warn', 'error'] as const) {
			expect(severityOf(levelOf(severity))).toBe(severity);
		}
	});
});
