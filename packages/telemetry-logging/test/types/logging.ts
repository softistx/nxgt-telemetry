/**
 * Type tests. They are checked by `bun run typecheck` and never run: a call
 * that must not compile carries `@ts-expect-error`, and if it starts compiling
 * tsc fails on the unused directive.
 */

import type { Exporter, Telemetry } from '@nxgt/telemetry';
import winston from 'winston';
import type { LogInfo, TelemetryFormat } from '../../src/bridge/format';
import { telemetryFormat } from '../../src/bridge/format';
import { levelOf, severityOf } from '../../src/bridge/levels';
import {
	type TelemetryTransport,
	telemetryTransport,
} from '../../src/bridge/transport';
import { winstonExporter } from '../../src/export/winston';

declare const telemetry: Telemetry;
declare const logger: winston.Logger;

// --- the format ----------------------------------------------------------

// It is what `combine` consumes: an object with `transform` and `options`.
const format: TelemetryFormat = telemetryFormat();
const info: LogInfo = format.transform({ level: 'info', message: 'hello' });
void info;

void telemetryFormat({ traceField: 'trace_id', spanField: 'span_id' });
void telemetryFormat({ attributes: false });

// @ts-expect-error — a field name is a string, not a boolean
void telemetryFormat({ traceField: true });

// @ts-expect-error — a misspelled option would otherwise be silently ignored
void telemetryFormat({ traceFields: 'trace_id' });

// @ts-expect-error — the format is built, not handed a line to transform
void telemetryFormat({ level: 'info', message: 'hello' });

// --- the transport -------------------------------------------------------

// It is what winston takes as a transport, which is the point.
const transport: TelemetryTransport = telemetryTransport({ telemetry });
void winston.createLogger({ transports: [transport] });

void telemetryTransport({ source: 'CheckoutService', fallback: 'error' });
void telemetryTransport({ level: 'warn', silent: true });
void telemetryTransport({ handleExceptions: true });

// @ts-expect-error — `fallback` is one of the four severities, not a winston level
void telemetryTransport({ fallback: 'silly' });

// @ts-expect-error — the telemetry is an instance, not a service name
void telemetryTransport({ telemetry: 'checkout' });

// @ts-expect-error — a misspelled option would otherwise be silently ignored
void telemetryTransport({ sources: 'CheckoutService' });

// @ts-expect-error — it is on or off, not a list of what to handle
void telemetryTransport({ handleExceptions: ['uncaughtException'] });

// --- the exporter --------------------------------------------------------

// It is an `Exporter`, which is the point: it goes in the same list as
// `consoleExporter()`.
const exporter: Exporter = winstonExporter({ logger });
void exporter;

void winstonExporter({ logger, spans: true, spanSeverity: 'debug' });
// Structural, so anything that can `log(level, message, meta)` fits — including
// `@nxgt/shared-logging`'s `Logger`, which is winston's own.
void winstonExporter({ logger: { log: (info) => info.level } });

// @ts-expect-error — the logger is not optional: there is nowhere else to write
void winstonExporter({ spans: true });

// @ts-expect-error — a span severity is one of the four, not a winston level
void winstonExporter({ logger, spanSeverity: 'silly' });

// @ts-expect-error — `spans` is on or off, not a count
void winstonExporter({ logger, spans: 10 });

// @ts-expect-error — an object with no `log` is not a logger
void winstonExporter({ logger: { write: () => undefined } });

// The single-argument form, which is the only one that does not lose the meta
// to winston's printf parsing.
void winstonExporter({
	// @ts-expect-error — `log(level, message, meta)` is not the shape this uses
	logger: { log: (level: string, message: string) => [level, message] },
});

// --- the levels ----------------------------------------------------------

const severity: 'debug' | 'info' | 'warn' | 'error' = severityOf('http');
void severity;
const level: string = levelOf('warn');
void level;

// @ts-expect-error — the fallback is a severity, not any string
void severityOf('crit', 'crit');

// @ts-expect-error — it maps a severity to a level, not the other way round
void levelOf('silly');
