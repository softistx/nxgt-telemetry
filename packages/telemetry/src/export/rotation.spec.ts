import { describe, expect, test } from 'bun:test';
import {
	prunable,
	type RotationPolicy,
	rolledName,
	rolledOf,
	rotationDue,
} from './rotation';

const DAY = 24 * 60 * 60 * 1000;

function policy(overrides: Partial<RotationPolicy> = {}): RotationPolicy {
	return { maxSize: 1_000, every: DAY, keep: 7, compress: false, ...overrides };
}

describe('rotationDue', () => {
	/**
	 * Rolling an empty file produces an empty archive and resets the period, so
	 * an idle service would accumulate a directory of nothing.
	 */
	test('an empty file is never rolled, whatever the clock says', () => {
		const yesterday = Date.UTC(2026, 8, 14, 23, 0);
		const today = Date.UTC(2026, 8, 15, 1, 0);

		expect(rotationDue(0, yesterday, today, policy())).toBe(false);
	});

	test('rolls once the file reaches maxSize', () => {
		expect(rotationDue(999, 0, 0, policy())).toBe(false);
		expect(rotationDue(1_000, 0, 0, policy())).toBe(true);
	});

	test('maxSize 0 disables the size rule', () => {
		expect(rotationDue(10_000, 0, 0, policy({ maxSize: 0, every: 0 }))).toBe(
			false,
		);
	});

	/**
	 * Epoch-aligned, not measured from when the file was opened: `every: 24h`
	 * rolls at UTC midnight, which is what somebody reading yesterday's file
	 * expects, rather than 24 hours after a restart.
	 */
	test('rolls when the period changes, not when a day has elapsed', () => {
		const lateYesterday = Date.UTC(2026, 8, 14, 23, 59);
		const earlyToday = Date.UTC(2026, 8, 15, 0, 1);
		const lateToday = Date.UTC(2026, 8, 15, 23, 0);

		// Two minutes apart, but on either side of UTC midnight.
		expect(rotationDue(10, lateYesterday, earlyToday, policy())).toBe(true);

		// Twenty-three hours apart, and the same day.
		expect(rotationDue(10, earlyToday, lateToday, policy())).toBe(false);
	});

	test('every 0 disables the time rule', () => {
		const lateYesterday = Date.UTC(2026, 8, 14, 23, 59);
		const today = Date.UTC(2026, 8, 15, 12, 0);

		expect(rotationDue(10, lateYesterday, today, policy({ every: 0 }))).toBe(
			false,
		);
	});
});

describe('rolledName', () => {
	const at = Date.UTC(2026, 8, 15, 10, 4, 22, 318);

	test('is the base, the UTC stamp and the extension', () => {
		expect(rolledName('logs/telemetry.jsonl', at)).toBe(
			'logs/telemetry-20260915-100422.jsonl',
		);
	});

	test('carries no colon, so it survives every filesystem', () => {
		expect(rolledName('logs/telemetry.jsonl', at)).not.toContain(':');
	});

	test('numbers a name that is already taken', () => {
		expect(rolledName('logs/telemetry.jsonl', at, 2)).toBe(
			'logs/telemetry-20260915-100422-2.jsonl',
		);
	});

	test('handles a file with no extension and no directory', () => {
		expect(rolledName('telemetry', at)).toBe('telemetry-20260915-100422');
	});

	test('keeps only the last extension', () => {
		expect(rolledName('logs/telemetry.log.jsonl', at)).toBe(
			'logs/telemetry.log-20260915-100422.jsonl',
		);
	});
});

describe('rolledOf', () => {
	const names = [
		'telemetry.jsonl',
		'telemetry-20260913-100422.jsonl',
		'telemetry-20260915-100422.jsonl',
		'telemetry-20260914-100422.jsonl.gz',
		'telemetry-20260914-100422-1.jsonl',
		'audit-20260915-100422.jsonl',
		'notes.txt',
	];

	test('finds the rolled files, newest first, and leaves everything else', () => {
		expect(rolledOf('logs/telemetry.jsonl', names)).toEqual([
			'telemetry-20260915-100422.jsonl',
			// `-1` is newer than the unsuffixed name of the same second: the
			// unsuffixed one is written first, and the collision number only
			// climbs.
			'telemetry-20260914-100422-1.jsonl',
			'telemetry-20260914-100422.jsonl.gz',
			'telemetry-20260913-100422.jsonl',
		]);
	});

	test('never matches the file currently being written', () => {
		expect(rolledOf('logs/telemetry.jsonl', names)).not.toContain(
			'telemetry.jsonl',
		);
	});

	test('never matches another service writing beside it', () => {
		expect(rolledOf('logs/telemetry.jsonl', names)).not.toContain(
			'audit-20260915-100422.jsonl',
		);
	});

	/**
	 * Sorting the names as text is wrong twice over inside one second: the
	 * collision number is not fixed-width, so `-9` sorts after `-12`, and the
	 * unsuffixed name — the oldest of that second — sorts after every suffixed
	 * one, because `.` is above `-`. Both mistakes put the newest archives at
	 * the end of the list, which is exactly where `keep` deletes from.
	 */
	test('orders a second of collisions by number, not as text', () => {
		const collided = [
			'telemetry-20260915-100422.jsonl',
			'telemetry-20260915-100422-9.jsonl',
			'telemetry-20260915-100422-12.jsonl',
			'telemetry-20260915-100422-3.jsonl',
		];

		expect(rolledOf('logs/telemetry.jsonl', collided)).toEqual([
			'telemetry-20260915-100422-12.jsonl',
			'telemetry-20260915-100422-9.jsonl',
			'telemetry-20260915-100422-3.jsonl',
			'telemetry-20260915-100422.jsonl',
		]);
	});

	/**
	 * `compress` writes the archive and then removes the plain file. If that
	 * removal failed, the two names are still one period — counting them twice
	 * would make `keep: 7` hold six.
	 */
	test('folds an archive and its plain twin into one period', () => {
		const twinned = [
			'telemetry-20260915-100422.jsonl',
			'telemetry-20260915-100422.jsonl.gz',
		];

		expect(rolledOf('logs/telemetry.jsonl', twinned)).toEqual([
			'telemetry-20260915-100422.jsonl.gz',
		]);
	});
});

describe('prunable', () => {
	const names = [
		'telemetry-20260915-100422.jsonl',
		'telemetry-20260914-100422.jsonl',
		'telemetry-20260913-100422.jsonl',
	];

	test('deletes the oldest beyond what is kept', () => {
		expect(prunable('logs/telemetry.jsonl', names, 2)).toEqual([
			'telemetry-20260913-100422.jsonl',
		]);
	});

	test('keep 0 deletes them all', () => {
		expect(prunable('logs/telemetry.jsonl', names, 0)).toHaveLength(3);
	});

	test('keeping more than there are deletes nothing', () => {
		expect(prunable('logs/telemetry.jsonl', names, 10)).toEqual([]);
	});

	test('never offers the live file, or another service beside it', () => {
		expect(
			prunable('logs/telemetry.jsonl', ['telemetry.jsonl', 'audit.jsonl'], 0),
		).toEqual([]);
	});

	/**
	 * The one case where more names are deleted than `rolledOf` lists: the
	 * plain twin `rolledOf` folded away is still a file on disk, and pruning
	 * the period has to take both.
	 */
	test('takes the plain twin of an archive it is dropping', () => {
		const twinned = [
			'telemetry-20260915-100422.jsonl',
			'telemetry-20260915-100422.jsonl.gz',
			'telemetry-20260916-100422.jsonl',
		];

		expect(prunable('logs/telemetry.jsonl', twinned, 1)).toEqual([
			'telemetry-20260915-100422.jsonl',
			'telemetry-20260915-100422.jsonl.gz',
		]);
	});

	/**
	 * The bug this ordering exists for: within one second, the newest archives
	 * are the highest-numbered ones. Keeping two has to keep those, not the two
	 * a lexical sort would have put first.
	 */
	test('keeps the newest of a second of collisions', () => {
		const collided = [
			'telemetry-20260915-100422.jsonl',
			'telemetry-20260915-100422-9.jsonl',
			'telemetry-20260915-100422-12.jsonl',
		];

		expect(prunable('logs/telemetry.jsonl', collided, 2)).toEqual([
			'telemetry-20260915-100422.jsonl',
		]);
	});
});
