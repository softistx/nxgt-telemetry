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

export function period(at: number, policy: RotationPolicy): number {
	return Math.floor(at / policy.every);
}

/**
 * `telemetry.jsonl` rolled at that instant becomes
 * `telemetry-20260915-100422.jsonl`, and `-1`, `-2`… if that name is taken.
 * UTC, and no colons: the name has to survive every filesystem.
 */
export function rolledName(path: string, at: number, taken = 0): string {
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	const directory = path.slice(0, slash + 1);
	const file = path.slice(slash + 1);

	const dot = file.lastIndexOf('.');
	const base = dot <= 0 ? file : file.slice(0, dot);
	const extension = dot <= 0 ? '' : file.slice(dot);

	const suffix = taken === 0 ? '' : `-${taken}`;
	return `${directory}${base}-${stamp(at)}${suffix}${extension}`;
}

/** The rolled files of `path`, newest first. Anything else is left alone. */
export function rolledOf(path: string, names: readonly string[]): string[] {
	const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	const file = path.slice(slash + 1);
	const dot = file.lastIndexOf('.');
	const base = dot <= 0 ? file : file.slice(0, dot);
	const extension = dot <= 0 ? '' : file.slice(dot);

	const pattern = new RegExp(
		`^${escape(base)}-\\d{8}-\\d{6}(-\\d+)?${escape(extension)}(\\.gz)?$`,
	);

	// The stamp sorts lexicographically because it is fixed-width and UTC, so
	// the name is the clock and no `stat` is needed to order them.
	return names
		.filter((name) => pattern.test(name))
		.sort()
		.reverse();
}

/** Which rolled files to delete, given how many to keep. */
export function prunable(
	path: string,
	names: readonly string[],
	keep: number,
): string[] {
	return rolledOf(path, names).slice(Math.max(keep, 0));
}

function stamp(at: number): string {
	const iso = new Date(at).toISOString();
	return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
}

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
