import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Resource, Signal } from '../model/signal';
import type { Exporter } from './exporter';
import {
	prunable,
	type RotationPolicy,
	rolledName,
	rotationDue,
} from './rotation';

/** 64 MiB. */
export const DEFAULT_MAX_SIZE = 64 * 1024 * 1024;
/** 24 hours, in milliseconds. Epoch-aligned, so it rolls at UTC midnight. */
export const DEFAULT_ROTATION_PERIOD = 24 * 60 * 60 * 1000;

export interface FileExporterOptions {
	/** The file to append to. Its directory is created if it is missing. */
	readonly path: string;
	/** Roll at this many bytes. `0` disables it. Default 64 MiB. */
	readonly maxSize?: number;
	/** Roll when this period changes, in ms. `0` disables it. Default 24h. */
	readonly every?: number;
	/** How many rolled files to keep. Default 7. */
	readonly keep?: number;
	/** Gzip a rolled file. Default false. */
	readonly compress?: boolean;
	/** For specs. Default `Date.now`. */
	readonly now?: () => number;
}

/**
 * One JSON object per signal, appended to a file, with rotation.
 *
 * ```ts
 * fileExporter({ path: 'logs/telemetry.jsonl', every: 0, maxSize: 8 * 1024 * 1024 })
 * ```
 *
 * The same line format as {@link jsonLinesExporter}, so a shipper reads either.
 * It **appends**: a restart continues the current file, and the period is read
 * from that file's modification time rather than from when this process
 * started, so a service that restarts hourly still rolls once a day.
 *
 * `close()` rolls nothing. A rolled file is a finished period, and a shutdown
 * is not one.
 */
export function fileExporter(options: FileExporterOptions): Exporter {
	const policy: RotationPolicy = {
		maxSize: options.maxSize ?? DEFAULT_MAX_SIZE,
		every: options.every ?? DEFAULT_ROTATION_PERIOD,
		keep: options.keep ?? 7,
		compress: options.compress ?? false,
	};
	const now = options.now ?? Date.now;
	const path = options.path;

	let state: { size: number; openedAt: number } | undefined;

	return {
		async export(_resource: Resource, batch: readonly Signal[]): Promise<void> {
			const text = render(batch);
			if (text.length === 0) return;

			state ??= await currentState(path, now());

			if (rotationDue(state.size, state.openedAt, now(), policy)) {
				await roll(path, now(), policy);
				state = { size: 0, openedAt: now() };
			}

			await appendFile(path, text, 'utf8');
			state.size += Buffer.byteLength(text, 'utf8');
		},
	};
}

function render(batch: readonly Signal[]): string {
	let text = '';
	for (const signal of batch) {
		try {
			text += `${JSON.stringify(signal)}\n`;
		} catch {
			// One signal that will not serialise must not cost the rest.
		}
	}
	return text;
}

/**
 * The size and age of the file we are about to append to. A file that is not
 * there yet is size 0 opened now; its **modification time** is when the current
 * period started, which is what makes a restart continue rather than reset.
 */
async function currentState(
	path: string,
	fallback: number,
): Promise<{ size: number; openedAt: number }> {
	await mkdir(dirname(path), { recursive: true }).catch(() => undefined);

	try {
		const found = await stat(path);
		return { size: found.size, openedAt: found.mtimeMs };
	} catch {
		return { size: 0, openedAt: fallback };
	}
}

async function roll(
	path: string,
	at: number,
	policy: RotationPolicy,
): Promise<void> {
	const target = await freeName(path, at);
	await rename(path, target);

	if (policy.compress) await compress(target);
	await prune(path, policy.keep);
}

/** Two rolls in the same second are possible; `-1`, `-2`… keep both. */
async function freeName(path: string, at: number): Promise<string> {
	for (let taken = 0; taken < 1_000; taken++) {
		const candidate = rolledName(path, at, taken);
		if (!(await exists(candidate)) && !(await exists(`${candidate}.gz`))) {
			return candidate;
		}
	}
	return rolledName(path, at, 1_000);
}

async function compress(path: string): Promise<void> {
	await writeFile(`${path}.gz`, gzipSync(await readFile(path)));
	await rm(path, { force: true });
}

async function prune(path: string, keep: number): Promise<void> {
	const directory = dirname(path);
	const names = await readdir(directory).catch(() => [] as string[]);

	for (const name of prunable(path, names, keep)) {
		await rm(`${directory}/${name}`, { force: true });
	}
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}
