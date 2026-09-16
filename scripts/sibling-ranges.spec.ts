import { describe, expect, test } from 'bun:test';
import {
	expectedRange,
	type PackedManifest,
	siblingRangeProblems,
} from './sibling-ranges';

const core = (version: string): PackedManifest => ({
	name: '@nxgt/telemetry',
	version,
});

const otlp = (range: string): PackedManifest => ({
	name: '@nxgt/telemetry-otlp',
	version: '0.2.1',
	dependencies: { '@nxgt/telemetry': range },
});

/** The integration as it is in the repository. */
const SOURCES = [core('x'), otlp('workspace:^')];

describe('siblingRangeProblems', () => {
	/**
	 * The 0.2.0 release: the core was bumped, `bun.lock` was not, and every
	 * integration was packed asking for `^0.1.0` — which in 0.x excludes 0.2.0.
	 */
	test('reports a range that excludes the sibling being published', () => {
		const problems = siblingRangeProblems(
			[core('0.2.0'), otlp('^0.1.0')],
			SOURCES,
		);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('@nxgt/telemetry-otlp');
		expect(problems[0]).toContain('^0.1.0');
		expect(problems[0]).toContain('bun install');
	});

	/**
	 * The same stale lock within one minor: `^0.2.0` accepts 0.2.1, and a
	 * consumer locked on 0.2.0 would still get it under an integration built
	 * against 0.2.1.
	 */
	test('reports a stale lower bound the sibling still satisfies', () => {
		expect(
			siblingRangeProblems([core('0.2.1'), otlp('^0.2.0')], SOURCES),
		).toHaveLength(1);
	});

	test('accepts exactly the range the workspace spec asks for', () => {
		expect(
			siblingRangeProblems([core('0.2.1'), otlp('^0.2.1')], SOURCES),
		).toEqual([]);
	});

	/** `Bun.semver.satisfies('0.2.0', 'garbage!!')` is `true`. */
	test('reports a packed range that is not a range at all', () => {
		for (const junk of ['garbage!!', 'latest', '', 'workspace:^']) {
			expect(
				siblingRangeProblems([core('0.2.0'), otlp(junk)], SOURCES),
			).toHaveLength(1);
		}
	});

	test('reads peers and optional dependencies too', () => {
		const a: PackedManifest = {
			name: '@nxgt/a',
			version: '1.0.0',
			peerDependencies: { '@nxgt/telemetry': '^0.9.0' },
			optionalDependencies: { '@nxgt/telemetry': '~0.9.0' },
		};
		const source: PackedManifest = {
			...a,
			peerDependencies: { '@nxgt/telemetry': 'workspace:^' },
			optionalDependencies: { '@nxgt/telemetry': 'workspace:~' },
		};

		expect(siblingRangeProblems([core('1.0.0'), a], [source])).toHaveLength(2);
	});

	test('ignores a dependency that is not published beside it', () => {
		const a: PackedManifest = {
			name: '@nxgt/a',
			version: '1.0.0',
			dependencies: { hono: '^3.0.0' },
		};
		expect(siblingRangeProblems([a], [a])).toEqual([]);
	});

	/** A sibling written as a plain range is the exact-pin check's business. */
	test('ignores a sibling that is not declared through workspace:', () => {
		expect(
			siblingRangeProblems(
				[core('0.2.0'), otlp('^0.1.0')],
				[core('x'), otlp('^0.1.0')],
			),
		).toEqual([]);
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
