import { describe, expect, test } from 'bun:test';
import { type PackedManifest, siblingRangeProblems } from './sibling-ranges';

const core = (version: string): PackedManifest => ({
	name: '@nxgt/telemetry',
	version,
});

const integration = (range: string): PackedManifest => ({
	name: '@nxgt/telemetry-otlp',
	version: '0.2.0',
	dependencies: { '@nxgt/telemetry': range },
});

describe('siblingRangeProblems', () => {
	/**
	 * The 0.2.0 release: the core was bumped, `bun.lock` was not, and every
	 * integration was packed asking for `^0.1.0` — which in 0.x excludes 0.2.0.
	 */
	test('reports a caret range that excludes the sibling being published', () => {
		const problems = siblingRangeProblems([
			core('0.2.0'),
			integration('^0.1.0'),
		]);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('@nxgt/telemetry-otlp');
		expect(problems[0]).toContain('^0.1.0');
		expect(problems[0]).toContain('bun install');
	});

	test('accepts a range the sibling satisfies', () => {
		expect(
			siblingRangeProblems([core('0.2.0'), integration('^0.2.0')]),
		).toEqual([]);
		expect(
			siblingRangeProblems([core('0.2.1'), integration('^0.2.0')]),
		).toEqual([]);
	});

	test('reads peers and optional dependencies too', () => {
		const problems = siblingRangeProblems([
			core('1.0.0'),
			{
				name: '@nxgt/a',
				version: '1.0.0',
				peerDependencies: { '@nxgt/telemetry': '^0.9.0' },
				optionalDependencies: { '@nxgt/telemetry': '~0.9.0' },
			},
		]);

		expect(problems).toHaveLength(2);
	});

	test('ignores a dependency that is not published beside it', () => {
		expect(
			siblingRangeProblems([
				{
					name: '@nxgt/a',
					version: '1.0.0',
					dependencies: { hono: '^3.0.0' },
				},
			]),
		).toEqual([]);
	});

	/** An unresolved protocol is another check's business. */
	test('leaves a workspace: or link: range to the check that owns it', () => {
		expect(
			siblingRangeProblems([core('0.2.0'), integration('workspace:^')]),
		).toEqual([]);
	});
});
