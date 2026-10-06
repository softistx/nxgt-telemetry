import { describe, expect, test } from 'bun:test';
import { accessProblems, manifestShapeProblems } from './manifest';

describe('manifestShapeProblems', () => {
	const adapter = (
		peerDependencies: Record<string, string>,
		name = '@nxgt/mongo-meilisearch',
	) => ({
		name,
		peerDependencies,
	});

	test('accepts a caret range on a sibling', () => {
		expect(
			manifestShapeProblems([
				{ name: '@nxgt/mongo' },
				adapter({ '@nxgt/mongo': '^0.2.0' }),
			]),
		).toEqual([]);
	});

	test('refuses an exact pin on a sibling: two copies, two ValidationError classes', () => {
		const problems = manifestShapeProblems([
			{ name: '@nxgt/mongo' },
			adapter({ '@nxgt/mongo': '0.2.0' }),
		]);
		expect(problems).toEqual([
			expect.stringContaining('pins a sibling exactly'),
		]);
	});

	test('refuses a package that lists itself', () => {
		const problems = manifestShapeProblems([
			{ name: '@nxgt/mongo', dependencies: { '@nxgt/mongo': '.' } },
		]);
		expect(problems).toEqual([expect.stringContaining('lists itself')]);
	});

	/** `bun pm pack` resolves every `workspace:`; one left means it did not. */
	test('refuses a workspace: left in a field a consumer installs, and not in devDependencies', () => {
		expect(
			manifestShapeProblems([
				{ name: '@nxgt/mongo' },
				{
					name: '@nxgt/mongo-meilisearch',
					peerDependencies: { '@nxgt/mongo': 'workspace:^' },
					devDependencies: { '@nxgt/mongo': 'workspace:^' },
				},
			]),
		).toEqual([
			'@nxgt/mongo-meilisearch: peerDependencies.@nxgt/mongo = workspace:^, ' +
				'which `bun pm pack` should have resolved',
		]);
	});

	test('refuses link: and file: where a consumer installs, and not in devDependencies', () => {
		expect(
			manifestShapeProblems([
				{
					name: '@nxgt/mongo',
					dependencies: { a: 'link:../a' },
					optionalDependencies: { b: 'file:../b' },
					devDependencies: { c: 'link:../c' },
				},
			]),
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
