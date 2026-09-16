import { basename } from 'node:path';

export interface RotationPolicy {
	/** Roll once the file is at least this many bytes. 0 disables it. */
	readonly maxSize: number;
	/** Roll when this many milliseconds' period changes. 0 disables it. */
	readonly every: number;
	/** How many rolled files to keep. 0 keeps none. */
	readonly keep: number;
	readonly compress: boolean;
}

/**
 * Whether the file open since `openedAt` should be rolled before the next
 * write.
 *
 * **An empty file is never rolled**, whatever the clock says: rolling one
 * produces an empty archive and resets the period, so an idle service would
 * accumulate a directory of nothing.
 *
 * The period is **epoch-aligned** rather than measured from when the file was
 * opened: `every: 24h` then rolls at UTC midnight, which is what somebody
 * reading yesterday's file expects, instead of 24 hours after a restart.
 */
export function rotationDue(
	size: number,
	openedAt: number,
	now: number,
	policy: RotationPolicy,
): boolean {
	if (size <= 0) return false;
	if (policy.maxSize > 0 && size >= policy.maxSize) return true;
	return policy.every > 0 && period(openedAt, policy) !== period(now, policy);
}

/**
 * `telemetry.jsonl` rolled at that instant becomes
 * `telemetry-20260915-100422.jsonl`, and `-1`, `-2`… if that name is taken.
 * UTC, and no colons: the name has to survive every filesystem.
 */
export function rolledName(path: string, at: number, taken = 0): string {
	const file = basename(path);
	const directory = path.slice(0, path.length - file.length);

	const dot = file.lastIndexOf('.');
	const base = dot <= 0 ? file : file.slice(0, dot);
	const extension = dot <= 0 ? '' : file.slice(dot);

	const suffix = taken === 0 ? '' : `-${taken}`;
	return `${directory}${base}-${stamp(at)}${suffix}${extension}`;
}

/**
 * The rolled files of `path`, **newest first**. Anything else — the live file,
 * another service's archives — is left alone.
 *
 * The order is taken from the parsed stamp and collision number, not from the
 * name as text. Sorting the names would be wrong twice over within one second:
 * the suffix is not fixed-width, so `-9` sorts after `-12`, and the unsuffixed
 * name — which is the *oldest* of that second — sorts after every suffixed one,
 * because `.` is above `-`.
 *
 * A gzipped archive and its plain twin are one period, and only the archive is
 * listed: a `compress` whose cleanup failed must not make `keep` prune a period
 * early.
 */
export function rolledOf(path: string, names: readonly string[]): string[] {
	const found = new Map<string, { name: string; at: string; taken: number }>();

	for (const name of names) {
		const rolled = parse(path, name);
		if (rolled === undefined) continue;

		const key = `${rolled.at}-${rolled.taken}`;
		const seen = found.get(key);
		// A `.gz` and its plain twin are the same period; prefer the archive.
		if (seen === undefined || name.endsWith('.gz')) {
			found.set(key, { ...rolled, name });
		}
	}

	return [...found.values()]
		.sort(
			(one, other) => other.at.localeCompare(one.at) || other.taken - one.taken,
		)
		.map((rolled) => rolled.name);
}

/** Which rolled files to delete, given how many to keep. */
export function prunable(
	path: string,
	names: readonly string[],
	keep: number,
): string[] {
	const kept = new Set(rolledOf(path, names).slice(0, Math.max(keep, 0)));
	// Everything that belongs to this file and is not kept, including the plain
	// twin of an archive `rolledOf` folded away.
	return names.filter(
		(name) => parse(path, name) !== undefined && !kept.has(name),
	);
}

function period(at: number, policy: RotationPolicy): number {
	return Math.floor(at / policy.every);
}

function parse(
	path: string,
	name: string,
): { at: string; taken: number } | undefined {
	const file = basename(path);
	const dot = file.lastIndexOf('.');
	const base = dot <= 0 ? file : file.slice(0, dot);
	const extension = dot <= 0 ? '' : file.slice(dot);

	const pattern = new RegExp(
		`^${escapeRegex(base)}-(\\d{8}-\\d{6})(?:-(\\d+))?${escapeRegex(extension)}(\\.gz)?$`,
	);

	const found = pattern.exec(name);
	if (found === null) return undefined;

	return { at: found[1] as string, taken: Number(found[2] ?? 0) };
}

function stamp(at: number): string {
	const iso = new Date(at).toISOString();
	return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
