import {
	type Attributes,
	attributesOf,
	coerceAttribute,
} from '../attributes/attributes';
import type { InferInput, StandardSchemaV1 } from './standard-schema';

/** A named thing that happened, with the fields its type declares. */
export interface TelemetryEvent {
	readonly name: string;
	readonly attributes: Attributes;
	/** True when the schema refused the input and the fields were read as-is. */
	readonly invalid?: boolean;
}

/** The marker an invalid event carries, so it can be found and fixed. */
export const INVALID_EVENT_ATTRIBUTE = 'telemetry.event.invalid';

export function event(
	name: string,
): (input?: Readonly<Record<string, unknown>>) => TelemetryEvent;

export function event<Schema extends StandardSchemaV1>(
	name: string,
	schema: Schema,
): (input: InferInput<Schema>) => TelemetryEvent;

/**
 * Declares an event type.
 *
 * ```ts
 * const Charged = event('checkout.charged', z.object({ orderId: z.string(), amount: z.number() }));
 *
 * log.info(Charged({ orderId, amount }));
 * ```
 *
 * Declaring what you log makes **choosing what is logged the same act as
 * writing the code**, rather than a redaction list somebody has to keep up to
 * date. Logging an object as it is logs the field added next quarter — the card
 * number included — and nobody finds out, because a log that says too much
 * still looks like a working log.
 *
 * The schema is the declaration, and what it returns is what is emitted: an
 * object schema's unknown keys are gone by the time this does. Any Standard
 * Schema will do — Zod, Valibot, ArkType — and none of them is a dependency
 * here.
 *
 * **It never throws.** A schema that refuses the input, or one that answers
 * asynchronously, still produces an event: the readable fields, plus
 * `telemetry.event.invalid`. A log call is a total function.
 */
export function event(
	name: string,
	schema?: StandardSchemaV1,
): (input?: never) => TelemetryEvent {
	return ((input?: Readonly<Record<string, unknown>>): TelemetryEvent => {
		if (schema === undefined) return { name, attributes: attributesOf(input) };

		let result: unknown;
		try {
			result = schema['~standard'].validate(input);
		} catch {
			return invalid(name, input);
		}

		if (isThenable(result)) {
			// Nothing here may await: `log.info` is called from constructors and
			// from `catch` blocks, where an async logger cannot be called at all.
			void Promise.resolve(result).catch(() => undefined);
			return invalid(name, input);
		}

		const checked = result as { value?: unknown; issues?: readonly unknown[] };
		if (checked.issues !== undefined) return invalid(name, input);

		return { name, attributes: fields(checked.value) };
	}) as (input?: never) => TelemetryEvent;
}

export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as TelemetryEvent).name === 'string' &&
		typeof (value as TelemetryEvent).attributes === 'object'
	);
}

function invalid(
	name: string,
	input: Readonly<Record<string, unknown>> | undefined,
): TelemetryEvent {
	return {
		name,
		attributes: { ...attributesOf(input), [INVALID_EVENT_ATTRIBUTE]: true },
		invalid: true,
	};
}

/** A schema may return something that is not a record; it still has to log. */
function fields(value: unknown): Attributes {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return attributesOf(value as Record<string, unknown>);
	}
	return { value: coerceAttribute(value) };
}

function isThenable(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { then?: unknown }).then === 'function'
	);
}
