import { describe, expect, test } from 'bun:test';
import { type Manifest, newest, rewrite } from './newest-peers';

test('the newest end of a range: its last alternative, or the range itself', () => {
	expect(newest('^6.0.3 || ^7.0.0')).toBe('^7.0.0');
	expect(newest('>=7.0.0 <8')).toBe('>=7.0.0 <8');
	expect(newest('^6.0.3')).toBe('^6.0.3');
	expect(newest('workspace:^')).toBeUndefined();
});

const root: Manifest = {
	devDependencies: { typescript: '~6.0.3' },
	overrides: { typescript: '~6.0.3' },
};
const pkg = (name: string, manifest: Manifest = {}): Manifest => ({
	name,
	peerDependencies: { typescript: '^6.0.3' },
	...manifest,
});

describe('rewrite', () => {
	test('a package’s own devDependency, the root’s, and every override', () => {
		const mongo = pkg('@nxgt/mongo', {
			peerDependencies: { mongodb: '>=7.0.0 <8', typescript: '^6.0.3' },
			devDependencies: { mongodb: '7.6.0' },
		});
		const result = rewrite(root, new Map([['m', mongo]]));
		expect(result.packages.get('m')?.devDependencies).toEqual({
			mongodb: '>=7.0.0 <8',
		});
		expect(result.root.devDependencies).toEqual({ typescript: '^6.0.3' });
		expect(result.root.overrides).toEqual({ typescript: '^6.0.3' });
		expect(mongo.devDependencies).toEqual({ mongodb: '7.6.0' });
	});

	test('every manifest that installs a peer gets its range: one version in the tree', () => {
		const mongo = pkg('@nxgt/mongo', {
			peerDependencies: { typescript: '^6.0.3', zod: '>=4.6.5 <5' },
			devDependencies: { zod: '4.6.5' },
		});
		// A kit installs zod for its specs without peering on it.
		const kit = pkg('@nxgt/mongo-kit', {
			peerDependencies: { '@nxgt/mongo': 'workspace:^' },
			devDependencies: { '@nxgt/mongo': 'workspace:^', zod: '4.6.5' },
		});
		const app: Manifest = {
			name: 'hono-api-example',
			dependencies: { '@nxgt/mongo': 'workspace:^', zod: '4.6.5' },
			devDependencies: { typescript: '~6.0.3' },
		};
		const result = rewrite(
			root,
			new Map([
				['m', mongo],
				['k', kit],
			]),
			new Map([['a', app]]),
		);
		expect(result.packages.get('k')?.devDependencies).toEqual({
			'@nxgt/mongo': 'workspace:^',
			zod: '>=4.6.5 <5',
		});
		expect(result.apps.get('a')?.dependencies).toEqual({
			'@nxgt/mongo': 'workspace:^',
			zod: '>=4.6.5 <5',
		});
		expect(result.apps.get('a')?.devDependencies).toEqual({
			typescript: '^6.0.3',
		});
	});

	test('a range nobody installs fails, rather than pass untested', () => {
		const lonely = pkg('@nxgt/x', {
			peerDependencies: { zod: '>=4.6.5 <5' },
		});
		expect(() => rewrite(root, new Map([['x', lonely]]))).toThrow(
			"add it to @nxgt/x's devDependencies",
		);
	});

	test('packages disagreeing on the newest fails', () => {
		const other = pkg('@nxgt/y', {
			peerDependencies: { typescript: '^6.0.3 || ^7.0.0' },
		});
		expect(() =>
			rewrite(
				root,
				new Map([
					['a', pkg('@nxgt/a')],
					['y', other],
				]),
			),
		).toThrow('disagree on the newest typescript');
	});

	test('no peer but siblings: nothing newer to test', () => {
		const bridge = {
			name: '@nxgt/z',
			peerDependencies: { '@nxgt/mongo': 'workspace:^' },
		};
		expect(() => rewrite(root, new Map([['z', bridge]]))).toThrow(
			'nothing newer to test',
		);
	});
});
