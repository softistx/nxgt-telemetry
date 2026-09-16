/**
 * Type tests. They are checked by `bun run typecheck` and never run: a call
 * that must not compile carries `@ts-expect-error`, and if it starts compiling
 * tsc fails on the unused directive.
 */

import { createHttpClient, type Middleware } from '@nxgt/httpyz';
import type { TracingOptions } from '../../src/middleware/tracing';
import { tracing } from '../../src/middleware/tracing';

// It is an httpyz middleware, and goes where one goes.
const middleware: Middleware = tracing();
void createHttpClient({ baseUrl: 'https://api.example', use: [tracing()] });
void middleware;

void tracing({
	traced: (call) => call.path !== '/health',
	spanName: (call, request) => `${call.method} ${new URL(request.url).host}`,
	url: () => undefined,
});

// @ts-expect-error — an unknown option is a typo, not an extension point
void tracing({ sampled: true });

// @ts-expect-error — `traced` answers yes or no, not a span name
void tracing({ traced: () => 'yes' });

// @ts-expect-error — a span name is a string; there is no default to fall back to
void tracing({ spanName: () => undefined });

// The call context is what httpyz hands over, and nothing more.
void tracing({
	// @ts-expect-error — a call has no `headers`; the request does
	traced: (call) => call.headers !== undefined,
});

// The options are read-only: a middleware does not change under the client.
const options: TracingOptions = {};
// @ts-expect-error — the hooks are fixed when the middleware is built
options.traced = () => true;
