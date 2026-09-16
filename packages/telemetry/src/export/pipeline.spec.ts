import { describe, expect, test } from 'bun:test';
import type { LogRecord, Resource, Signal } from '../model/signal';
import type { Exporter } from './exporter';
import { Pipeline, type PipelineOptions } from './pipeline';

const RESOURCE: Resource = { service: 'checkout', attributes: {} };

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

function recorder() {
	const batches: (readonly Signal[])[] = [];
	const exporter: Exporter = {
		export(_resource, batch) {
			batches.push(batch);
		},
	};
	return { batches, exporter, names: () => batches.flat().map((s) => s.name) };
}

function pipeline(
	exporters: readonly Exporter[],
	overrides: Partial<PipelineOptions> = {},
) {
	const failures: unknown[] = [];
	const instance = new Pipeline({
		resource: RESOURCE,
		exporters,
		batch: 512,
		linger: 1_000,
		drainTimeout: 10_000,
		onExportError: (failure) => failures.push(failure),
		...overrides,
	});
	return { instance, failures };
}

describe('flushing', () => {
	test('ships once the batch size is reached, and not before', async () => {
		const { batches, exporter } = recorder();
		const { instance } = pipeline([exporter], { batch: 3 });

		instance.post(log('a'));
		instance.post(log('b'));
		await Promise.resolve();
		expect(batches).toHaveLength(0);

		instance.post(log('c'));
		await instance.close();
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(3);
	});

	test('ships on the linger timer without reaching the batch size', async () => {
		const { batches, exporter } = recorder();
		const { instance } = pipeline([exporter], { batch: 100, linger: 5 });

		instance.post(log('a'));
		await Bun.sleep(30);

		expect(batches).toHaveLength(1);
		await instance.close();
	});

	test('preserves the order things happened in', async () => {
		const { exporter, names } = recorder();
		const { instance } = pipeline([exporter], { batch: 2 });

		for (const name of ['a', 'b', 'c', 'd', 'e']) instance.post(log(name));
		await instance.close();

		expect(names()).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	test('a slow exporter does not let a later batch overtake an earlier one', async () => {
		const seen: string[] = [];
		const slow: Exporter = {
			async export(_resource, batch) {
				await Bun.sleep(batch[0]?.name === 'a' ? 20 : 0);
				for (const signal of batch) seen.push(signal.name);
			},
		};
		const { instance } = pipeline([slow], { batch: 1 });

		instance.post(log('a'));
		instance.post(log('b'));
		await instance.close();

		expect(seen).toEqual(['a', 'b']);
	});
});

describe('an exporter that fails', () => {
	test('is reported, and the next one still gets the batch', async () => {
		const { batches, exporter } = recorder();
		const hostile: Exporter = {
			export() {
				throw new Error('collector is down');
			},
		};
		const { instance, failures } = pipeline([hostile, exporter], { batch: 1 });

		instance.post(log('a'));
		await instance.close();

		expect(failures).toHaveLength(1);
		expect(batches).toHaveLength(1);
	});

	test('rejecting asynchronously is reported the same way', async () => {
		const hostile: Exporter = {
			export: () => Promise.reject(new Error('timed out')),
		};
		const { instance, failures } = pipeline([hostile], { batch: 1 });

		instance.post(log('a'));
		await instance.close();

		expect(failures).toHaveLength(1);
	});

	test('an onExportError that throws does not propagate', async () => {
		const hostile: Exporter = {
			export() {
				throw new Error('down');
			},
		};
		const instance = new Pipeline({
			resource: RESOURCE,
			exporters: [hostile],
			batch: 1,
			linger: 1_000,
			drainTimeout: 1_000,
			onExportError() {
				throw new Error('and the handler is broken too');
			},
		});

		instance.post(log('a'));
		await instance.close();
	});

	test('a close that fails is reported, not thrown', async () => {
		const hostile: Exporter = {
			export() {},
			close() {
				throw new Error('socket stuck');
			},
		};
		const { instance, failures } = pipeline([hostile]);

		await instance.close();
		expect(failures).toHaveLength(1);
	});
});

describe('close', () => {
	test('ships what was waiting', async () => {
		const { exporter, names } = recorder();
		const { instance } = pipeline([exporter], { batch: 512 });

		instance.post(log('a'));
		await instance.close();

		expect(names()).toEqual(['a']);
	});

	test('closes every exporter, once', async () => {
		let closed = 0;
		const { instance } = pipeline([
			{ export() {}, close: () => void closed++ },
		]);

		await instance.close();
		await instance.close();

		expect(closed).toBe(1);
	});

	/**
	 * A SIGTERM handler awaits this. Both halves have to be bounded: an export
	 * that never answers, and an exporter that will not let go of its socket.
	 * Bounding only the first leaves the process hanging on the second.
	 */
	test('returns within drainTimeout against an export that never answers', async () => {
		const stuck: Exporter = { export: () => new Promise<void>(() => {}) };
		const { instance, failures } = pipeline([stuck], {
			batch: 1,
			drainTimeout: 20,
		});

		instance.post(log('a'));
		const started = Date.now();
		await instance.close();

		expect(Date.now() - started).toBeLessThan(1_000);
		expect(String(failures[0])).toContain('did not ship');
	});

	test('returns within drainTimeout against a close that never answers', async () => {
		const stuck: Exporter = {
			export() {},
			close: () => new Promise<void>(() => {}),
		};
		const { instance } = pipeline([stuck], { batch: 1, drainTimeout: 20 });

		instance.post(log('a'));
		const started = Date.now();
		await instance.close();

		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test('a drain that had time is not reported as a timeout', async () => {
		const { exporter } = recorder();
		const { instance, failures } = pipeline([exporter], {
			batch: 1,
			drainTimeout: 1_000,
		});

		instance.post(log('a'));
		await instance.close();

		expect(failures).toEqual([]);
	});

	test('post after close is refused rather than throwing', async () => {
		const { batches, exporter } = recorder();
		const { instance } = pipeline([exporter], { batch: 1 });

		await instance.close();

		expect(instance.post(log('late'))).toBe(false);
		expect(batches).toHaveLength(0);
	});

	test('post before close is accepted', () => {
		const { instance } = pipeline([]);
		expect(instance.post(log('a'))).toBe(true);
	});
});
