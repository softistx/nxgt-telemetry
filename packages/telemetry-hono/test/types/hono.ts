/**
 * Type tests. They are checked by `bun run typecheck` and never run: a call
 * that must not compile carries `@ts-expect-error`, and if it starts compiling
 * tsc fails on the unused directive.
 */

import {
	createTelemetry,
	type SpanScope,
	type Telemetry,
} from '@nxgt/telemetry';
import { Hono } from 'hono';
import type { TelemetryMiddleware } from '../../src/middleware/telemetry';
import { telemetry } from '../../src/middleware/telemetry';

declare const instance: Telemetry;

// The two shapes: build one, or hand one over.
const built: TelemetryMiddleware = telemetry({ service: 'checkout' });
const adopted: TelemetryMiddleware = telemetry({ instance });

// The telemetry comes back, so the application can close it.
const owned: Telemetry = built.telemetry;
void owned;
void adopted;

// The `service` shape takes everything `createTelemetry` takes.
void telemetry({
	service: 'checkout',
	version: '1.4.0',
	environment: 'production',
	minimum: 'debug',
	batch: 64,
	exporters: [],
	traced: (c) => c.req.path !== '/health',
	spanName: (c) => `${c.req.method} ${c.req.path}`,
	route: () => undefined,
});

// @ts-expect-error — one or the other: a service beside an instance is ignored
void telemetry({ service: 'checkout', instance });

// @ts-expect-error — neither is not a middleware, it is a typo
void telemetry({});

// @ts-expect-error — the service name has no default; it is what everything groups by
void telemetry({ version: '1.4.0' });

// @ts-expect-error — `traced` answers yes or no, not a span name
void telemetry({ service: 'checkout', traced: () => 'yes' });

// @ts-expect-error — the telemetry options belong to the `service` shape only
void telemetry({ instance, batch: 64 });

// It is a hono middleware, and goes where one goes.
const app = new Hono();
app.use('*', built);

// The context variables are typed, in a handler that imports nothing from here.
app.get('/orders/:id', (c) => {
	const scope: SpanScope | undefined = c.get('span');
	const used: Telemetry | undefined = c.get('telemetry');
	scope?.attribute('tenant', 'acme');
	scope?.fail(new Error('refused'));
	void used;
	return c.text('ok');
});

app.get('/typed', (c) => {
	// @ts-expect-error — `span` is a scope, not a string
	const wrong: string = c.get('span');
	void wrong;

	// A request `traced` refused never had either set, so the compiler makes
	// the handler say so rather than the README.
	// @ts-expect-error — it is absent whenever `traced` said no
	const unguarded: SpanScope = c.get('span');
	void unguarded;

	// @ts-expect-error — so is the telemetry
	const missing: Telemetry = c.get('telemetry');
	void missing;

	return c.text('ok');
});

// @ts-expect-error — a telemetry is not a middleware
app.use('*', createTelemetry('checkout'));
