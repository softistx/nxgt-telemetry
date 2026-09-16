import { afterEach, describe, expect, test } from 'bun:test';
import type { Exporter } from '../export/exporter';
import type { LogRecord, Signal } from '../model/signal';
import { alwaysSample, ratioSampler } from '../trace/sampler';
import {
	createTelemetry,
	installedTelemetry,
	TELEMETRY_DEFAULTS,
	uninstallTelemetry,
} from './telemetry';

afterEach(() => uninstallTelemetry());

function log(name: string): LogRecord {
	return {
		type: 'log',
		at: 0,
		severity: 'info',
		name,
		source: 'spec',
		attributes: {},
	};
}

function collector() {
	const signals: Signal[] = [];
	const exporter: Exporter = {
		export(_resource, batch) {
			signals.push(...batch);
		},
	};
	return { signals, exporter };
}

describe('the resource', () => {
	test('carries the service, and only the fields that were given', () => {
		expect(createTelemetry('checkout').resource).toEqual({
			service: 'checkout',
			attributes: {},
		});
	});

	test('carries version, environment and coerced attributes when they are', () => {
		expect(
			createTelemetry('checkout', {
				version: '1.4.0',
				environment: 'production',
				attributes: { region: 'eu-west-1', replicas: 3, skip: undefined },
			}).resource,
		).toEqual({
			service: 'checkout',
			version: '1.4.0',
			environment: 'production',
			attributes: { region: 'eu-west-1', replicas: 3 },
		});
	});
});

describe('the defaults', () => {
	test('are the ones stx-telemetry uses, so the two estates behave alike', () => {
		expect(TELEMETRY_DEFAULTS).toEqual({
			minimum: 'info',
			stackTraces: true,
			batch: 512,
			linger: 1_000,
			drainTimeout: 10_000,
		});
	});

	test('and a telemetry built with nothing takes them', () => {
		const telemetry = createTelemetry('checkout');
		expect(telemetry.minimum).toBe('info');
		expect(telemetry.stackTraces).toBe(true);
		expect(telemetry.sampler).toBe(alwaysSample);
	});

	test('an option replaces one', () => {
		const sampler = ratioSampler(0.5);
		const telemetry = createTelemetry('checkout', {
			minimum: 'debug',
			stackTraces: false,
			sampler,
		});

		expect(telemetry.minimum).toBe('debug');
		expect(telemetry.stackTraces).toBe(false);
		expect(telemetry.sampler).toBe(sampler);
	});
});

describe('install', () => {
	test('nothing is installed until something installs itself', () => {
		createTelemetry('checkout');
		expect(installedTelemetry()).toBeUndefined();
	});

	test('install returns the instance, and it is the one found', () => {
		const telemetry = createTelemetry('checkout');
		expect(telemetry.install()).toBe(telemetry);
		expect(installedTelemetry()).toBe(telemetry);
	});

	test('closing stands it down', async () => {
		const telemetry = createTelemetry('checkout').install();
		await telemetry.close();
		expect(installedTelemetry()).toBeUndefined();
	});

	test('closing one that is not installed leaves the installed one alone', async () => {
		const installed = createTelemetry('checkout').install();
		await createTelemetry('other').close();
		expect(installedTelemetry()).toBe(installed);
	});
});

describe('emit', () => {
	test('reaches the exporters on close', async () => {
		const { signals, exporter } = collector();
		const telemetry = createTelemetry('checkout', { exporters: [exporter] });

		expect(telemetry.emit(log('a'))).toBe(true);
		await telemetry.close();

		expect(signals.map((s) => s.name)).toEqual(['a']);
	});

	test('is refused after close, rather than throwing', async () => {
		const telemetry = createTelemetry('checkout');
		await telemetry.close();
		expect(telemetry.emit(log('late'))).toBe(false);
	});

	test('with no exporter at all, it still answers', async () => {
		const telemetry = createTelemetry('checkout');
		expect(telemetry.emit(log('a'))).toBe(true);
		await telemetry.close();
	});
});

describe('asyncDispose', () => {
	test('closes it', async () => {
		const { signals, exporter } = collector();
		{
			await using telemetry = createTelemetry('checkout', {
				exporters: [exporter],
			});
			telemetry.emit(log('a'));
		}
		expect(signals).toHaveLength(1);
	});
});
