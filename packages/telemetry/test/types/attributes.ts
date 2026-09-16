/**
 * Type tests. They are checked by `bun run typecheck` and never run: a call
 * that must not compile carries `@ts-expect-error`, and if it starts compiling
 * tsc fails on the unused directive.
 *
 * Type safety is what the compiler rejects, not what a README claims.
 */

import type {
	Attributes,
	AttributeValue,
} from '../../src/attributes/attributes';
import { attributesOf, mergeAttributes } from '../../src/attributes/attributes';
import type { Severity, SpanKind, SpanStatus } from '../../src/model/signal';
import { meetsSeverity } from '../../src/model/signal';
import type { SpanId, TraceId } from '../../src/trace/ids';
import {
	isValidTraceId,
	randomSpanId,
	randomTraceId,
	renderTraceparent,
} from '../../src/trace/ids';
import { ratioSampler } from '../../src/trace/sampler';

// An attribute is a scalar, or a list of scalars.
const scalar: AttributeValue = 'charged';
const list: AttributeValue = ['a', 1, true, null];
void scalar;
void list;

// @ts-expect-error — structure is an event type, not an attribute
const structured: AttributeValue = { orderId: 'o-1' };
void structured;

// @ts-expect-error — a list of lists is not a list of scalars
const nested: AttributeValue = [['a']];
void nested;

// Attributes are read-only: what was emitted stays what was emitted.
const attributes: Attributes = attributesOf({ orderId: 'o-1' });
// @ts-expect-error — an emitted attribute map is not a scratchpad
attributes.orderId = 'o-2';

// A coercion is the only way in, so `unknown` is accepted at the door...
const coerced = attributesOf({ whatever: new Date() });
void mergeAttributes(attributes, coerced);

// ...but an already-typed map cannot be merged with a loose record.
// @ts-expect-error — mergeAttributes takes Attributes, not any record
void mergeAttributes(attributes, { at: new Date() });

// The ids are branded: the two are both strings and must not be interchangeable.
const traceId: TraceId = randomTraceId();
const spanId: SpanId = randomSpanId();

// @ts-expect-error — a span id is not a trace id
const wrong: TraceId = spanId;
void wrong;

// @ts-expect-error — a bare hex string has not been validated
const unchecked: TraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
void unchecked;

// A guard is how a string becomes one.
const candidate = '4bf92f3577b34da6a3ce929d0e0e4736';
if (isValidTraceId(candidate)) {
	const validated: TraceId = candidate;
	void validated;
}

void renderTraceparent({ traceId, spanId, sampled: true, remote: false });

// @ts-expect-error — a context needs its flags, not only its ids
void renderTraceparent({ traceId, spanId });

// @ts-expect-error — the sampler takes a trace id, not a span id
void ratioSampler(0.5).sample(spanId);

// The vocabulary is closed: a level, a kind or a status outside it is rejected.
const severity: Severity = 'warn';
const kind: SpanKind = 'server';
const status: SpanStatus = 'cancelled';
void severity;
void kind;
void status;

// @ts-expect-error — there is no trace level; sub-debug detail is a span attribute
const missing: Severity = 'trace';
void missing;

// @ts-expect-error — a span kind is not free text
const invented: SpanKind = 'database';
void invented;

// @ts-expect-error — a status is one of three
const optimistic: SpanStatus = 'success';
void optimistic;

void meetsSeverity(severity, 'info');
