import type { Severity } from '@nxgt/telemetry';

/**
 * winston's npm levels, and the four this library has.
 *
 * The mapping is lossy in one direction on purpose. `Severity` has four levels
 * because a log level is a *routing* decision and four is as many as anybody
 * routes on; winston's `http`, `verbose` and `silly` are shades of the two it
 * already has, so they land on `info` and `debug` rather than inventing
 * severities nothing downstream would understand.
 *
 * A level winston was configured with but that is not listed here — a custom
 * level set, `syslog`'s `notice`, `crit`, `emerg` — is **not** guessed at. See
 * {@link severityOf}.
 */
export const SEVERITY_OF_LEVEL: Readonly<Record<string, Severity>> = {
	error: 'error',
	warn: 'warn',
	info: 'info',
	http: 'info',
	verbose: 'debug',
	debug: 'debug',
	silly: 'debug',
};

/** The npm level a signal is written at, going the other way. */
export const LEVEL_OF_SEVERITY: Readonly<Record<Severity, string>> = {
	debug: 'debug',
	info: 'info',
	warn: 'warn',
	error: 'error',
};

/**
 * What a winston level means here, or the fallback.
 *
 * The fallback is **`info`**, and it matters which way it errs: a custom level
 * mapped down to `debug` would be dropped by a pipeline with the default
 * `minimum`, and a line that disappears is worse than one recorded a shade too
 * loudly. A `syslog` logger's `crit` arriving as `info` is visible and wrong;
 * as `debug` it is invisible and wrong.
 */
export function severityOf(
	level: string,
	fallback: Severity = 'info',
): Severity {
	if (typeof level !== 'string') return fallback;
	// winston's `colorize` format rewrites `level` in place, escape codes and
	// all, and a logger that colourises before this transport is a normal
	// configuration rather than a mistake.
	return SEVERITY_OF_LEVEL[uncoloured(level).trim().toLowerCase()] ?? fallback;
}

/** The winston level for a severity. Total: every severity has one. */
export function levelOf(severity: Severity): string {
	return LEVEL_OF_SEVERITY[severity] ?? 'info';
}

const ESCAPE = '\x1b';
// biome-ignore lint/suspicious/noControlCharactersInRegex: an escape sequence is made of control characters, which is the thing being removed
const ANSI = /\x1b\[[0-9;]*m/g;

function uncoloured(level: string): string {
	return level.includes(ESCAPE) ? level.replace(ANSI, '') : level;
}
