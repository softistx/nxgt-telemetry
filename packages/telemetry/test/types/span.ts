/**
 * Type tests for the two verbs that produce signals. Checked by
 * `bun run typecheck`, never run.
 */

import { event } from '../../src/logger/event';
import { createLogger } from '../../src/logger/logger';
import type { StandardSchemaV1 } from '../../src/logger/standard-schema';
import { continuing, span } from '../../src/span/span';

// The block is what makes it a span; the options are optional.
const one: Promise<number> = span('charge', async () => 1);
const two: Promise<number> = span('charge', { kind: 'client' }, async () => 1);
const three: Promise<void> = continuing(null, 'GET /orders', async () => {});
void one;
void two;
void three;

// @ts-expect-error — a span without a block is a name and nothing else
span('charge');

// @ts-expect-error — a span kind is one of five, not free text
span('charge', { kind: 'database' }, async () => {});

// @ts-expect-error — attributes are a record, not a string
span('charge', { attributes: 'orderId' }, async () => {});

// @ts-expect-error — an unknown option is a typo, not an extension point
span('charge', { sampled: true }, async () => {});

// @ts-expect-error — continuing needs the name of the span it opens
continuing(null, async () => {});

await span('charge', async (scope) => {
	// The name is writable: routing knows the template last.
	scope.name = 'GET /orders/{id}';
	scope.status = 'error';
	scope.attribute('http.route', '/orders/{id}');
	scope.attributes({ retries: 2 });
	scope.event('gateway.called', { attempt: 1 });

	// @ts-expect-error — a status is one of three
	scope.status = 'failed';

	// @ts-expect-error — the context is what was decided, not a field to rewrite
	scope.context.traceId = scope.spanId;

	// @ts-expect-error — the span id is not a trace id
	const wrong: typeof scope.traceId = scope.spanId;
	void wrong;

	// @ts-expect-error — attributes takes a record, not a pair
	scope.attributes('http.route', '/orders/{id}');
});

const log = createLogger('CheckoutService');
const Charged = event('checkout.charged');

log.debug('quiet');
log.debug(() => 'built only if debug is on');
log.info(Charged({ orderId: 'o-1' }));
log.warn('charge refused', { code: 51 });
log.error('charge failed', new Error('no funds'), { orderId: 'o-1' });

// The lazy form is for debug and info: at warn and error the message is always
// built, so a thunk would only hide the cost of building it.
// @ts-expect-error — no lazy message at warn
log.warn(() => 'late');

// @ts-expect-error — no lazy message at error
log.error(() => 'late');

// @ts-expect-error — a level is a method, not an argument
log.log('info', 'charged');

// A schema declares the fields, and the compiler checks the call against it.
const schema: StandardSchemaV1<{ orderId: string }, { orderId: string }> = {
	'~standard': {
		version: 1,
		vendor: 'spec',
		validate: (value) => ({ value: value as { orderId: string } }),
		types: { input: { orderId: '' }, output: { orderId: '' } },
	},
};
const Typed = event('checkout.charged', schema);

Typed({ orderId: 'o-1' });

// @ts-expect-error — the schema says orderId is a string
Typed({ orderId: 42 });

// @ts-expect-error — a declared field is not optional
Typed({});
