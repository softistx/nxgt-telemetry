import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { LogRecord, Resource } from '../model/signal';
import {
	DEFAULT_MAX_SIZE,
	DEFAULT_ROTATION_PERIOD,
	fileExporter,
} from './file';

const RESOURCE: Resource = { service: 'checkout', attributes: {} };
const DAY = 24 * 60 * 60 * 1000;

let directory: string;
let path: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'nxgt-telemetry-file-'));
	path = join(directory, 'telemetry.jsonl');
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

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

async function names(): Promise<string[]> {
	return (await readdir(directory)).sort();
}

async function read(file = path): Promise<string> {
	return readFile(file, 'utf8');
}

describe('appending', () => {
	test('writes one line per signal, in order', async () => {
		const exporter = fileExporter({ path });

		await exporter.export(RESOURCE, [log('a'), log('b')]);
		await exporter.export(RESOURCE, [log('c')]);

		const written = (await read()).trim().split('\n');
		expect(written).toHaveLength(3);
		expect(written.map((line) => JSON.parse(line).name)).toEqual([
			'a',
			'b',
			'c',
		]);
	});

	test('creates the directory it was pointed at', async () => {
		const nested = join(directory, 'deep', 'deeper', 'telemetry.jsonl');
		await fileExporter({ path: nested }).export(RESOURCE, [log('a')]);

		expect(JSON.parse(await read(nested)).name).toBe('a');
	});

	test('an empty batch writes nothing, and does not create the file', async () => {
		await fileExporter({ path }).export(RESOURCE, []);
		expect(await names()).toEqual([]);
	});

	test('appends to what a previous process left', async () => {
		await writeFile(path, '{"type":"log","name":"earlier"}\n');
		await fileExporter({ path }).export(RESOURCE, [log('later')]);

		expect((await read()).trim().split('\n')).toHaveLength(2);
	});
});

describe('rolling on size', () => {
	test('rolls once the file reaches maxSize, and starts a new one', async () => {
		const exporter = fileExporter({ path, maxSize: 60, every: 0, keep: 7 });

		await exporter.export(RESOURCE, [log('first')]);
		await exporter.export(RESOURCE, [log('second')]);

		const written = await names();
		expect(written).toHaveLength(2);
		expect(written.filter((name) => name !== 'telemetry.jsonl')).toHaveLength(
			1,
		);
		expect(JSON.parse(await read()).name).toBe('second');
	});

	test('the rolled file keeps what was there', async () => {
		const exporter = fileExporter({ path, maxSize: 60, every: 0 });

		await exporter.export(RESOURCE, [log('first')]);
		await exporter.export(RESOURCE, [log('second')]);

		const rolled = (await names()).find((name) => name !== 'telemetry.jsonl');
		expect(JSON.parse(await read(join(directory, rolled as string))).name).toBe(
			'first',
		);
	});

	test('two rolls in the same second both survive', async () => {
		const frozen = Date.UTC(2026, 8, 15, 10, 4, 22);
		const exporter = fileExporter({
			path,
			maxSize: 1,
			every: 0,
			now: () => frozen,
		});

		await exporter.export(RESOURCE, [log('a')]);
		await exporter.export(RESOURCE, [log('b')]);
		await exporter.export(RESOURCE, [log('c')]);

		expect(await names()).toEqual([
			'telemetry-20260915-100422-1.jsonl',
			'telemetry-20260915-100422.jsonl',
			'telemetry.jsonl',
		]);
	});
});

describe('rolling on the clock', () => {
	test('rolls when the UTC period changes', async () => {
		let at = Date.UTC(2026, 8, 14, 23, 59);
		const exporter = fileExporter({
			path,
			maxSize: 0,
			every: DAY,
			now: () => at,
		});

		await exporter.export(RESOURCE, [log('yesterday')]);
		at = Date.UTC(2026, 8, 15, 0, 1);
		await exporter.export(RESOURCE, [log('today')]);

		expect(await names()).toEqual([
			'telemetry-20260915-000100.jsonl',
			'telemetry.jsonl',
		]);
		expect(JSON.parse(await read()).name).toBe('today');
	});

	test('does not roll within the same period', async () => {
		let at = Date.UTC(2026, 8, 15, 0, 1);
		const exporter = fileExporter({
			path,
			maxSize: 0,
			every: DAY,
			now: () => at,
		});

		await exporter.export(RESOURCE, [log('early')]);
		at = Date.UTC(2026, 8, 15, 23, 0);
		await exporter.export(RESOURCE, [log('late')]);

		expect(await names()).toEqual(['telemetry.jsonl']);
	});
});

describe('keeping and compressing', () => {
	test('keeps only the newest rolled files', async () => {
		let at = Date.UTC(2026, 8, 15, 10, 0, 0);
		const exporter = fileExporter({
			path,
			maxSize: 1,
			every: 0,
			keep: 2,
			now: () => at,
		});

		for (let i = 0; i < 5; i++) {
			await exporter.export(RESOURCE, [log(`line-${i}`)]);
			at += 1_000;
		}

		const rolled = (await names()).filter((name) => name !== 'telemetry.jsonl');
		expect(rolled).toHaveLength(2);
		expect(rolled).toEqual([
			'telemetry-20260915-100003.jsonl',
			'telemetry-20260915-100004.jsonl',
		]);
	});

	test('gzips a rolled file when asked, and leaves no plain copy', async () => {
		const exporter = fileExporter({
			path,
			maxSize: 1,
			every: 0,
			compress: true,
			now: () => Date.UTC(2026, 8, 15, 10, 4, 22),
		});

		await exporter.export(RESOURCE, [log('rolled')]);
		await exporter.export(RESOURCE, [log('current')]);

		expect(await names()).toEqual([
			'telemetry-20260915-100422.jsonl.gz',
			'telemetry.jsonl',
		]);

		const archive = await readFile(
			join(directory, 'telemetry-20260915-100422.jsonl.gz'),
		);
		expect(JSON.parse(gunzipSync(archive).toString('utf8')).name).toBe(
			'rolled',
		);
	});

	test('leaves another service writing beside it alone', async () => {
		await writeFile(
			join(directory, 'audit-20260915-100422.jsonl'),
			'keep me\n',
		);
		const exporter = fileExporter({
			path,
			maxSize: 1,
			every: 0,
			keep: 0,
			now: () => Date.UTC(2026, 8, 15, 10, 4, 22),
		});

		await exporter.export(RESOURCE, [log('a')]);
		await exporter.export(RESOURCE, [log('b')]);

		expect(await names()).toContain('audit-20260915-100422.jsonl');
	});
});

describe('the defaults', () => {
	test('are 64 MiB and a UTC day', () => {
		expect(DEFAULT_MAX_SIZE).toBe(64 * 1024 * 1024);
		expect(DEFAULT_ROTATION_PERIOD).toBe(DAY);
	});

	test('so an ordinary batch does not roll anything', async () => {
		const exporter = fileExporter({ path });

		await exporter.export(RESOURCE, [log('a')]);
		await exporter.export(RESOURCE, [log('b')]);

		expect(await names()).toEqual(['telemetry.jsonl']);
	});
});
