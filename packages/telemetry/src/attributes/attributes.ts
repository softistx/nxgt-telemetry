/**
 * An attribute is a scalar, or a list of scalars. That is what a backend can
 * index, filter and group by, and it is what OTLP accepts. Anything with
 * structure is an event type, not an attribute.
 *
 * The coercion below never refuses a value: a log call must not fail, so a
 * shape that does not belong here is rendered rather than rejected.
 */

export type AttributeScalar = string | number | boolean | null;

export type AttributeValue = AttributeScalar | readonly AttributeScalar[];

export type Attributes = Readonly<Record<string, AttributeValue>>;

/** Shared, frozen, and the one to return when there is nothing to say. */
export const EMPTY_ATTRIBUTES: Attributes = Object.freeze({});

/**
 * What a value reads as when reading it threw. A getter that throws, a revoked
 * Proxy and a `toString` that raises all arrive here — from application code,
 * in a `catch`, which is exactly where a log must not become the second
 * failure.
 */
export const UNREADABLE = '[unreadable]';

/**
 * Whatever a caller passed, as something that can be indexed.
 *
 * - `undefined` and a symbol render as `null`;
 * - a non-finite number renders as its text, because `NaN` is not JSON;
 * - a `bigint` renders as its text, for the same reason;
 * - a `Date` renders as an ISO-8601 instant;
 * - an array renders element by element, and a nested array is flattened into
 *   text rather than dropped;
 * - anything else is JSON if it will serialise, and `String(value)` if it will
 *   not — a circular object still says something.
 */
export function coerceAttribute(value: unknown): AttributeValue {
	try {
		return coerce(value);
	} catch {
		// Reading the value ran application code, and it threw. Writing a
		// signal is a total function: it says so and carries on.
		return UNREADABLE;
	}
}

function coerce(value: unknown): AttributeValue {
	if (value === null || value === undefined) return null;

	switch (typeof value) {
		case 'string':
		case 'boolean':
			return value;
		case 'number':
			return Number.isFinite(value) ? value : String(value);
		case 'bigint':
			return String(value);
		case 'symbol':
		case 'function':
			return null;
	}

	if (value instanceof Date) {
		const at = value.getTime();
		return Number.isNaN(at) ? String(value) : value.toISOString();
	}

	if (Array.isArray(value)) return value.map(coerceScalar);

	return render(value);
}

/**
 * A record of anything, as attributes. Keys whose value is `undefined` are
 * dropped — `{ orderId, code }` with no `code` should not log `code: null` —
 * while an explicit `null` is kept, because somebody wrote it.
 */
export function attributesOf(
	input: Readonly<Record<string, unknown>> | undefined,
): Attributes {
	if (input === undefined || input === null) return EMPTY_ATTRIBUTES;

	// `Object.keys` runs an `ownKeys` trap, and reading a key runs a getter.
	// Both are application code on the path that writes a signal.
	let keys: string[];
	try {
		keys = Object.keys(input);
	} catch {
		return EMPTY_ATTRIBUTES;
	}

	const attributes: Record<string, AttributeValue> = {};
	let any = false;

	for (const key of keys) {
		let value: unknown;
		try {
			value = input[key];
		} catch {
			attributes[key] = UNREADABLE;
			any = true;
			continue;
		}

		if (value === undefined) continue;
		attributes[key] = coerceAttribute(value);
		any = true;
	}

	return any ? attributes : EMPTY_ATTRIBUTES;
}

/** Both, with the right-hand side winning. Neither argument is modified. */
export function mergeAttributes(
	left: Attributes,
	right: Attributes,
): Attributes {
	if (left === right) return left;
	if (isEmpty(left)) return right;
	if (isEmpty(right)) return left;
	return { ...left, ...right };
}

export function isEmptyAttributes(attributes: Attributes): boolean {
	return isEmpty(attributes);
}

function isEmpty(attributes: Attributes): boolean {
	for (const _ in attributes) return false;
	return true;
}

function coerceScalar(value: unknown): AttributeScalar {
	const coerced = coerceAttribute(value);
	return Array.isArray(coerced) ? render(value) : (coerced as AttributeScalar);
}

function render(value: unknown): string {
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return json;
	} catch {
		// Circular, or a `toJSON` that threw. `String` still says something.
	}

	try {
		return String(value);
	} catch {
		return UNREADABLE;
	}
}
