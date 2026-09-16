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

describe('recovering from the filesystem', () => {
	/**
	 * The failure that made this exporter worth a rewrite: one roll that threw
	 * left `size` above `maxSize` for ever, so every later batch tried to
	 * rename a file that was no longer there, failed the same way, and the
	 * process looked healthy while writing nothing at all.
	 */
	test('a failed roll costs one batch, not every batch after it', async () => {
		const exporter = fileExporter({ path, maxSize: 1, every: 0 });

		await exporter.export(RESOURCE, [log('first')]);

		// What an external `logrotate` — or an operator — does.
		await rm(path);

		await expect(exporter.export(RESOURCE, [log('lost')])).rejects.toThrow();

		await exporter.export(RESOURCE, [log('after')]);
		expect(JSON.parse(await read()).name).toBe('after');
	});

	/**
	 * Anything remembered is a cache of the filesystem, and a truncation is the
	 * cheap way to prove it is re-derived: the size it holds is now wrong, and
	 * only reading the file again makes the next roll land where it should.
	 */
	test('re-reads the file after a failure, rather than trusting what it held', async () => {
		let at = Date.UTC(2026, 8, 15, 10, 4, 22);
		const exporter = fileExporter({
			path,
			maxSize: 1,
			every: 0,
			now: () => at,
		});

		await exporter.export(RESOURCE, [log('first')]);
		await rm(path);
		await expect(exporter.export(RESOURCE, [log('lost')])).rejects.toThrow();

		// The file is gone, so this batch appends to a new one without rolling
		// — a stale size would have rolled it — and only the batch after it
		// rolls, onto a name of its own second.
		await exporter.export(RESOURCE, [log('second')]);
		at += 1_000;
		await exporter.export(RESOURCE, [log('third')]);

		expect(await names()).toEqual([
			'telemetry-20260915-100423.jsonl',
			'telemetry.jsonl',
		]);
		expect(
			JSON.parse(await read(join(directory, 'telemetry-20260915-100423.jsonl')))
				.name,
		).toBe('second');
	});

	/**
	 * The pipeline never calls an exporter twice at once, but a second
	 * telemetry — or a caller holding this exporter directly — can. Two
	 * interleaved rolls would rename the same file twice and lose a batch.
	 */
	test('serialises concurrent batches instead of interleaving them', async () => {
		const exporter = fileExporter({
			path,
			maxSize: 1,
			every: 0,
			now: () => Date.UTC(2026, 8, 15, 10, 4, 22),
		});

		await Promise.all([
			exporter.export(RESOURCE, [log('a')]),
			exporter.export(RESOURCE, [log('b')]),
			exporter.export(RESOURCE, [log('c')]),
		]);

		expect(await names()).toEqual([
			'telemetry-20260915-100422-1.jsonl',
			'telemetry-20260915-100422.jsonl',
			'telemetry.jsonl',
		]);

		const written = await Promise.all(
			(await names()).map((name) => read(join(directory, name))),
		);
		expect(
			written
				.flatMap((file) =>
					file
						.trim()
						.split('\n')
						.map((line) => JSON.parse(line).name),
				)
				.sort(),
		).toEqual(['a', 'b', 'c']);
	});

	/**
	 * A thousand archives of one second means the clock is stuck or the name is
	 * not ours. Renaming onto the thousandth would destroy it in silence;
	 * failing the batch is reported, and the next one re-reads the directory.
	 */
	test('refuses to roll when a second is full, rather than overwriting', async () => {
		const stamp = 'telemetry-20260915-100422';
		await Promise.all(
			Array.from({ length: 1_000 }, (_unused, taken) =>
				writeFile(
					join(
						directory,
						taken === 0 ? `${stamp}.jsonl` : `${stamp}-${taken}.jsonl`,
					),
					'',
				),
			),
		);

		const exporter = fileExporter({
			path,
			maxSize: 1,
			every: 0,
			keep: 1_000,
			now: () => Date.UTC(2026, 8, 15, 10, 4, 22),
		});

		await exporter.export(RESOURCE, [log('first')]);
		await expect(exporter.export(RESOURCE, [log('second')])).rejects.toThrow(
			'already share this second',
		);
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
