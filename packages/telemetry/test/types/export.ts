/**
 * Type tests for the exporter contract. Checked by `bun run typecheck` and
 * never run: a call that must not compile carries `@ts-expect-error`, and if it
 * starts compiling tsc fails on the unused directive.
 */

import { consoleExporter } from '../../src/export/console';
import type { Exporter } from '../../src/export/exporter';
import { fileExporter } from '../../src/export/file';
import { jsonLinesExporter } from '../../src/export/json-lines';
import type { RotationPolicy } from '../../src/export/rotation';
import { rolledName } from '../../src/export/rotation';
import type { LogRecord, Resource, Signal } from '../../src/model/signal';

const resource: Resource = { service: 'checkout', attributes: {} };
const batch: readonly Signal[] = [];

// An exporter is one function and an optional `close`.
const minimal: Exporter = {
	export: () => undefined,
};
void minimal.export(resource, batch);

const closing: Exporter = {
	export: async () => undefined,
	close: async () => undefined,
};
void closing;

// `export` is declared as a property, not a method, so its parameters are
// checked contravariantly. This is the point of that: an exporter that asks for
// a mutable array would be free to sort or splice a batch somebody else still
// holds.
const mutating: Exporter = {
	// @ts-expect-error — a batch arrives read-only and stays read-only
	export: (_resource: Resource, signals: Signal[]) => {
		signals.length = 0;
	},
};
void mutating;

const narrowed: Exporter = {
	// @ts-expect-error — a batch carries spans as well as logs
	export: (_resource: Resource, logs: readonly LogRecord[]) => {
		void logs;
	},
};
void narrowed;

// The built-in exporters take options objects, and every field is optional
// except `fileExporter`'s path.
void consoleExporter();
void consoleExporter({
	write: (line: string) => void line,
	stackTraces: false,
});
void jsonLinesExporter();
void fileExporter({ path: 'logs/telemetry.jsonl' });
void fileExporter({
	path: 'logs/telemetry.jsonl',
	maxSize: 0,
	every: 0,
	keep: 3,
	compress: true,
	now: () => 0,
});

// @ts-expect-error — the path is what this exporter owns; there is no default
void fileExporter({});

// @ts-expect-error — a misspelled option would otherwise be silently ignored
void fileExporter({ path: 'logs/telemetry.jsonl', maxsize: 10 });

// @ts-expect-error — sizes are numbers, not `'64mb'`
void fileExporter({ path: 'logs/telemetry.jsonl', maxSize: '64mb' });

// A policy is read-only: rotation is decided from it, never adjusted in place.
const policy: RotationPolicy = {
	maxSize: 1,
	every: 1,
	keep: 1,
	compress: false,
};
// @ts-expect-error — a policy does not change under the exporter holding it
policy.keep = 2;

void rolledName('logs/telemetry.jsonl', 0);
void rolledName('logs/telemetry.jsonl', 0, 2);

// The period helper is deliberately not part of the surface: it means nothing
// without the policy that produced it.
// @ts-expect-error — `period` is internal to rotation
export { period } from '../../src/export/rotation';
