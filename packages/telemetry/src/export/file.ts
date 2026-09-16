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
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { Resource, Signal } from '../model/signal';
import type { Exporter } from './exporter';
import {
	prunable,
	type RotationPolicy,
	rolledName,
	rotationDue,
} from './rotation';

const compressed = promisify(gzip);

/** 64 MiB. */
export const DEFAULT_MAX_SIZE = 64 * 1024 * 1024;
/** 24 hours, in milliseconds. Epoch-aligned, so it rolls at UTC midnight. */
export const DEFAULT_ROTATION_PERIOD = 24 * 60 * 60 * 1000;
/** How many archives may share one second before a roll gives up. */
const MAX_COLLISIONS = 1_000;

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
 * The same line format as `jsonLinesExporter`, so a shipper reads either. It
 * **appends**: a restart continues the current file, and the period is read
 * from that file's modification time rather than from when this process
 * started, so a service that restarts hourly still rolls once a day.
 *
 * `close()` rolls nothing. A rolled file is a finished period, and a shutdown is
 * not one.
 *
 * **This exporter owns its path.** It is the one stateful exporter here — it
 * remembers the file's size and age rather than asking the filesystem on every
 * batch — so give each path exactly one exporter. Calls are serialised
 * internally, and any failure throws away what it remembered, so an external
 * `logrotate` or a full disk costs the batch it happened on and nothing after
 * it.
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
	let queue: Promise<unknown> = Promise.resolve();

	const write = async (batch: readonly Signal[]): Promise<void> => {
		const text = render(batch);
		if (text.length === 0) return;

		try {
			// Whatever we remember is only a cache of the filesystem, and it is
			// re-derived after any failure: a roll that threw would otherwise
			// leave `size` above `maxSize` for ever, so every later batch would
			// try to rename a file that is no longer there, and the process
			// would look healthy while writing nothing.
			state ??= await currentState(path, now());

			if (rotationDue(state.size, state.openedAt, now(), policy)) {
				await roll(path, now(), policy);
				state = { size: 0, openedAt: now() };
			}

			await appendFile(path, text, 'utf8');
			state.size += Buffer.byteLength(text, 'utf8');
		} catch (failure) {
			state = undefined;
			throw failure;
		}
	};

	return {
		export(_resource: Resource, batch: readonly Signal[]): Promise<void> {
			// The pipeline never calls an exporter twice at once, but a second
			// telemetry — or a caller holding this exporter — could. The chain
			// makes that safe rather than interleaved.
			const next = queue.then(() => write(batch));
			queue = next.catch(() => undefined);
			return next;
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
	await mkdir(dirname(path), { recursive: true });

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
	for (let taken = 0; taken < MAX_COLLISIONS; taken++) {
		const candidate = rolledName(path, at, taken);
		if (!(await exists(candidate)) && !(await exists(`${candidate}.gz`))) {
			return candidate;
		}
	}

	// Renaming onto the thousandth name would destroy that archive in silence.
	// Failing the batch is reported, and the next one re-reads the directory.
	throw new Error(
		`[telemetry] ${MAX_COLLISIONS} archives of ${path} already share this second`,
	);
}

/**
 * Compress in place: the archive is written under a temporary name and moved
 * over, so a reader never sees a half-written `.gz`. If the plain file survives
 * the cleanup, `rolledOf` folds the pair back into one period rather than
 * counting it twice and pruning a period early.
 */
async function compress(path: string): Promise<void> {
	const pending = `${path}.gz.pending`;
	await writeFile(pending, await compressed(await readFile(path)));
	await rename(pending, `${path}.gz`);
	await rm(path, { force: true });
}

async function prune(path: string, keep: number): Promise<void> {
	const directory = dirname(path);
	const names = await readdir(directory);

	for (const name of prunable(path, names, keep)) {
		await rm(join(directory, name), { force: true });
	}
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}
