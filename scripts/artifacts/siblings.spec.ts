import { describe, expect, test } from 'bun:test';
import {
	expectedRange,
	type SiblingManifest,
	siblingRangeProblems,
} from './siblings';

const mongo = (version: string): SiblingManifest => ({
	name: '@nxgt/mongo',
	version,
});

const adapter = (range: string): SiblingManifest => ({
	name: '@nxgt/mongo-meilisearch',
	version: '0.1.0',
	peerDependencies: { '@nxgt/mongo': range },
});

/** The workspace: `@nxgt/mongo` at 0.2.1, asked for by `workspace:^`. */
const SOURCES = [mongo('0.2.1'), adapter('workspace:^')];

describe('siblingRangeProblems', () => {
	/**
	 * `@nxgt/mongo-meilisearch` 0.1.0: `changeset version` bumped the sibling,
	 * `bun.lock` kept the old number, and the pack asked for a range that
	 * leaves the new sibling out.
	 */
	test('refuses a range that leaves out the sibling beside it', () => {
		const problems = siblingRangeProblems(
			[mongo('0.2.1'), adapter('^0.1.0')],
			SOURCES,
		);
		expect(problems).toEqual([
			'@nxgt/mongo-meilisearch: peerDependencies.@nxgt/mongo = ^0.1.0, ' +
				'but workspace:^ beside @nxgt/mongo@0.2.1 packs as ^0.2.1; ' +
				'bun.lock is stale: run `bun install --lockfile-only`',
		]);
	});

	/**
	 * The same stale lock within one minor: 0.2.1 satisfies `^0.2.0`, so a
	 * consumer locked on 0.2.0 keeps it under a package built against 0.2.1.
	 */
	test('refuses a stale lower bound the sibling still satisfies', () => {
		expect(
			siblingRangeProblems([mongo('0.2.1'), adapter('^0.2.0')], SOURCES),
		).toEqual([expect.stringContaining('packs as ^0.2.1')]);
	});

	test('accepts exactly the range the workspace spec asks for', () => {
		expect(
			siblingRangeProblems([mongo('0.2.1'), adapter('^0.2.1')], SOURCES),
		).toEqual([]);
	});

	/** `Bun.semver.satisfies('0.2.1', 'garbage!!')` is `true`. */
	test('refuses a packed range that is not a range at all', () => {
		for (const junk of ['garbage!!', 'latest', '']) {
			expect(
				siblingRangeProblems([mongo('0.2.1'), adapter(junk)], SOURCES),
			).toHaveLength(1);
		}
	});

	/** An unresolved `workspace:` is the manifest check's to report, once. */
	test('leaves a workspace: that was never resolved to the manifest check', () => {
		expect(
			siblingRangeProblems([mongo('0.2.1'), adapter('workspace:^')], SOURCES),
		).toEqual([]);
	});

	/** `workspace:>=0.2.0` packs as `>=0.2.0`, whatever the version beside it. */
	test('takes an explicit range after workspace: as it is', () => {
		const sources = [mongo('0.2.1'), adapter('workspace:>=0.2.0')];
		expect(
			siblingRangeProblems([mongo('0.2.1'), adapter('>=0.2.0')], sources),
		).toEqual([]);
		for (const other of ['^0.2.1', '>=0.2.1', '^0.2.0', '0.2.1']) {
			expect(
				siblingRangeProblems([mongo('0.2.1'), adapter(other)], sources),
			).toEqual([expect.stringContaining('packs as >=0.2.0')]);
		}
	});

	/** A manifest is JSON: a range that is not a string is reported, not a crash. */
	test('reports a range that is not a string', () => {
		const packed = {
			name: '@nxgt/mongo-meilisearch',
			version: '0.1.0',
			peerDependencies: { '@nxgt/mongo': 1 },
		};
		expect(siblingRangeProblems([mongo('0.2.1'), packed], SOURCES)).toEqual([
			'@nxgt/mongo-meilisearch: peerDependencies.@nxgt/mongo = 1, ' +
				'which is not a version range',
		]);
	});

	test('follows ~ and * as well as ^, in every field a consumer installs', () => {
		const packed: SiblingManifest = {
			name: '@nxgt/a',
			version: '1.0.0',
			dependencies: { '@nxgt/mongo': '0.2.0' },
			peerDependencies: { '@nxgt/mongo': '^0.2.0' },
			optionalDependencies: { '@nxgt/mongo': '~0.2.0' },
		};
		const source: SiblingManifest = {
			...packed,
			dependencies: { '@nxgt/mongo': 'workspace:*' },
			peerDependencies: { '@nxgt/mongo': 'workspace:^' },
			optionalDependencies: { '@nxgt/mongo': 'workspace:~' },
		};
		expect(
			siblingRangeProblems([mongo('0.2.1'), packed], [mongo('0.2.1'), source]),
		).toEqual([
			expect.stringContaining('dependencies.@nxgt/mongo = 0.2.0'),
			expect.stringContaining('peerDependencies.@nxgt/mongo = ^0.2.0'),
			expect.stringContaining('optionalDependencies.@nxgt/mongo = ~0.2.0'),
		]);
	});

	test('ignores a dependency that is not a package of this workspace', () => {
		const a: SiblingManifest = {
			name: '@nxgt/a',
			version: '1.0.0',
			dependencies: { hono: '^3.0.0' },
		};
		expect(siblingRangeProblems([a], [a])).toEqual([]);
	});

	/**
	 * A sibling written as a plain range keeps the looser check: it must
	 * still let in the sibling beside it.
	 */
	test('holds a sibling written without workspace: to the version beside it', () => {
		const plain = [mongo('0.2.1'), adapter('^0.1.0')];
		expect(siblingRangeProblems(plain, plain)).toEqual([
			'@nxgt/mongo-meilisearch: peerDependencies.@nxgt/mongo = ^0.1.0 ' +
				'leaves out @nxgt/mongo@0.2.1, the version beside it; ' +
				'run `bun install --lockfile-only`',
		]);
		const fresh = [mongo('0.2.1'), adapter('^0.2.0')];
		expect(siblingRangeProblems(fresh, fresh)).toEqual([]);
	});
});

describe('expectedRange', () => {
	test('follows the workspace operator', () => {
		expect(expectedRange('workspace:^', '1.2.3')).toBe('^1.2.3');
		expect(expectedRange('workspace:~', '1.2.3')).toBe('~1.2.3');
		expect(expectedRange('workspace:*', '1.2.3')).toBe('1.2.3');
		expect(expectedRange('workspace:^1.0.0', '1.2.3')).toBe('^1.0.0');
	});

	test('has nothing to say about a spec that is not a workspace one', () => {
		expect(expectedRange('^1.0.0', '1.2.3')).toBeUndefined();
	});
});
