/**
 * Type tests for the root and the context. Checked by `bun run typecheck`,
 * never run.
 */

import {
	currentSpan,
	withAttributes,
	withTelemetry,
} from '../../src/context/current';
import type { Exporter } from '../../src/export/exporter';
import type { Resource, Severity, Signal } from '../../src/model/signal';
import { createTelemetry, type Telemetry } from '../../src/telemetry/telemetry';
import { ratioSampler } from '../../src/trace/sampler';

const telemetry: Telemetry = createTelemetry('checkout', {
	version: '1.0.0',
	sampler: ratioSampler(0.1),
	minimum: 'debug',
	exporters: [],
});

// @ts-expect-error — the service is the key everything groups by; it has no default
createTelemetry();

// @ts-expect-error — there is no trace level
createTelemetry('checkout', { minimum: 'trace' });

// @ts-expect-error — the floor is a severity, not a number
createTelemetry('checkout', { minimum: 9 });

// @ts-expect-error — an unknown option is a typo, not an extension point
createTelemetry('checkout', { sampleRate: 0.1 });

// The resource is what an exporter reads, and it is read-only.
const resource: Resource = telemetry.resource;
// @ts-expect-error — a resource is not something an exporter may rewrite
resource.service = 'other';

// @ts-expect-error — the sampler is resolved at construction, not swapped later
telemetry.sampler = ratioSampler(0.5);

// An exporter is one method, plus an optional close.
const exporter: Exporter = {
	export(_resource: Resource, _batch: readonly Signal[]) {},
};
void exporter;

// @ts-expect-error — the resource comes with every batch; the signature is fixed
const wrongArity: Exporter = { export(_batch: readonly Signal[]) {} };
void wrongArity;

const mutating: Exporter = {
	// @ts-expect-error — a batch is what arrived, not a list to append to
	export(_resource: Resource, batch: Signal[]) {
		batch.push(batch[0] as Signal);
	},
};
void mutating;

// `withTelemetry` and `withAttributes` return whatever the block returns.
const answer: number = withTelemetry(telemetry, () => 1);
const named: Promise<string> = withAttributes(
	{ tenant: 'acme' },
	async () => 'ok',
);
void answer;
void named;

// @ts-expect-error — attributes are a record, not a list of pairs
withAttributes([['tenant', 'acme']], () => 1);

const severity: Severity = 'warn';
void severity;

// The current span may not be there, and the compiler says so.
const spanId = currentSpan()?.spanId;
// @ts-expect-error — there may be no span open here
const required: string = currentSpan().spanId;
void spanId;
void required;
