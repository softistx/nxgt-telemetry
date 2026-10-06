import { describe, expect, test } from 'bun:test';
import { accessProblems, manifestShapeProblems } from './manifest';

describe('manifestShapeProblems', () => {
	const versions = {
		'@nxgt/mongo': '0.2.0',
		'@nxgt/mongo-meilisearch': '0.1.0',
	};
	const adapter = (
		peerDependencies: Record<string, string>,
		name = '@nxgt/mongo-meilisearch',
	) => ({
		name,
		peerDependencies,
	});

	test('accepts a caret range on a sibling that includes it', () => {
		expect(
			manifestShapeProblems(
				[{ name: '@nxgt/mongo' }, adapter({ '@nxgt/mongo': '^0.2.0' })],
				versions,
			),
		).toEqual([]);
	});

	test('refuses an exact pin on a sibling: two copies, two ValidationError classes', () => {
		const problems = manifestShapeProblems(
			[{ name: '@nxgt/mongo' }, adapter({ '@nxgt/mongo': '0.2.0' })],
			versions,
		);
		expect(problems).toEqual([
			expect.stringContaining('pins a sibling exactly'),
		]);
	});

	test('refuses a sibling range that leaves out the sibling beside it', () => {
		const problems = manifestShapeProblems(
			[{ name: '@nxgt/mongo' }, adapter({ '@nxgt/mongo': '^0.1.0' })],
			versions,
		);
		expect(problems).toEqual([
			expect.stringContaining('leaves out @nxgt/mongo@0.2.0'),
		]);
	});

	test('refuses a package that lists itself', () => {
		const problems = manifestShapeProblems(
			[{ name: '@nxgt/mongo', dependencies: { '@nxgt/mongo': '.' } }],
			{},
		);
		expect(problems).toEqual([expect.stringContaining('lists itself')]);
	});

	test('refuses link: and file: where a consumer installs, and not in devDependencies', () => {
		expect(
			manifestShapeProblems(
				[
					{
						name: '@nxgt/mongo',
						dependencies: { a: 'link:../a' },
						optionalDependencies: { b: 'file:../b' },
						devDependencies: { c: 'link:../c' },
					},
				],
				{},
			),
		).toEqual([
			'@nxgt/mongo: dependencies.a = link:../a',
			'@nxgt/mongo: optionalDependencies.b = file:../b',
		]);
	});
});

describe('accessProblems', () => {
	test('accepts a scoped package published as public', () => {
		expect(
			accessProblems({
				name: '@nxgt/mongo',
				publishConfig: { access: 'public' },
			}),
		).toEqual([]);
	});

	test('refuses a scoped package with no publishConfig', () => {
		expect(accessProblems({ name: '@nxgt/mongo' })).toEqual([
			'@nxgt/mongo: publishConfig.access is not "public"; bun publish would publish this scoped package as restricted',
		]);
	});
});
