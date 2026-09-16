/**
 * Type tests. They are checked by `bun run typecheck` and never run: a call
 * that must not compile carries `@ts-expect-error`, and if it starts compiling
 * tsc fails on the unused directive.
 */

import type { AttributeValue, Exporter } from '@nxgt/telemetry';
import { anyValue, nanos } from '../../src/convert';
import type { OtlpRefusedError, OtlpRejectedError } from '../../src/errors';
import type { OtlpExporterOptions, PartialSuccessReport } from '../../src/otlp';
import { otlpExporter } from '../../src/otlp';
import type { AnyValue } from '../../src/wire';

// It is an `Exporter`, which is the whole point: it goes in the same list as
// `consoleExporter()`.
const exporter: Exporter = otlpExporter({ endpoint: 'http://localhost:4318' });
void exporter;

void otlpExporter({
	endpoint: 'http://localhost:4318',
	logsPath: '/otlp/v1/logs',
	tracesPath: '/otlp/v1/traces',
	headers: { 'x-api-key': 'k' },
	timeout: 5_000,
	attempts: 5,
	backoff: 250,
	gzip: false,
	onPartialSuccess: (report: PartialSuccessReport) => void report.rejected,
	fetch,
	sleep: async () => undefined,
});

// @ts-expect-error — there is no default collector to fall back to
void otlpExporter({});

// @ts-expect-error — a misspelled option would otherwise be silently ignored
void otlpExporter({ endpoint: 'http://x', attemps: 3 });

// @ts-expect-error — a timeout is milliseconds, not '5s'
void otlpExporter({ endpoint: 'http://x', timeout: '5s' });

// @ts-expect-error — headers are strings; a number would serialise by accident
void otlpExporter({ endpoint: 'http://x', headers: { 'x-tenant': 7 } });

// The options are read-only: an exporter does not change under the telemetry
// holding it.
const options: OtlpExporterOptions = { endpoint: 'http://localhost:4318' };
// @ts-expect-error — the endpoint is fixed when the exporter is built
options.endpoint = 'http://elsewhere';

// A partial success reports a count, not the records themselves: the collector
// does not say which ones.
const report: PartialSuccessReport = {
	signal: 'logs',
	rejected: 2,
	message: 'quota',
};
void report;

const wrong: PartialSuccessReport = {
	// @ts-expect-error — there are two documents, and 'metrics' is not one
	signal: 'metrics',
	rejected: 0,
	message: '',
};
void wrong;

// The converter takes what the model produces, and nothing else.
const scalar: AttributeValue = 4200;
const tagged: AnyValue = anyValue(scalar);
void tagged;

// @ts-expect-error — structure is an event type, not an attribute
void anyValue({ orderId: 'o-1' });

// Nanoseconds cross the wire as text, and the signature says so.
const at: string = nanos(0);
void at;

// @ts-expect-error — it is a string precisely because a number loses the low bits
const asNumber: number = nanos(0);
void asNumber;

// The errors carry what a handler needs to decide whether to care.
declare const refused: OtlpRefusedError;
const status: number = refused.status;
const attempts: number = refused.attempts;
void status;
void attempts;

// @ts-expect-error — the three errors are distinct classes, not one with a flag
const rejected: OtlpRejectedError = refused;
void rejected;

// Which document failed is part of every failure: a mixed batch is two
// requests, and either can be the one that did not arrive.
const which: 'logs' | 'traces' = refused.signal;
void which;
