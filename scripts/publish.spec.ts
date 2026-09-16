import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	appendChangesetsOutput,
	changesetsGitTagEvent,
	inDependencyOrder,
	type Pkg,
} from './publish';

describe('changesets/action@v2 output', () => {
	test('emits one NDJSON git-tag event per line', () => {
		const line = changesetsGitTagEvent('@nxgt/shared', '@nxgt/shared@1.2.3');
		expect(line.endsWith('\n')).toBe(true);
		expect(JSON.parse(line)).toEqual({
			type: 'git-tag',
			tag: '@nxgt/shared@1.2.3',
			packageName: '@nxgt/shared',
		});
	});

	test('appends events so a second publish does not clobber the first', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'changesets-output-'));
		const path = join(dir, 'output.ndjson');
		await appendChangesetsOutput(path, '@nxgt/i18n', '@nxgt/i18n@1.0.3');
		await appendChangesetsOutput(path, '@nxgt/shared', '@nxgt/shared@1.0.4');
		const raw = await readFile(path, 'utf8');
		const events = raw
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(events).toEqual([
			{
				type: 'git-tag',
				tag: '@nxgt/i18n@1.0.3',
				packageName: '@nxgt/i18n',
			},
			{
				type: 'git-tag',
				tag: '@nxgt/shared@1.0.4',
				packageName: '@nxgt/shared',
			},
		]);
	});
});

describe('inDependencyOrder', () => {
	const pkg = (name: string, deps: string[] = []): Pkg => ({
		name,
		version: '1.0.0',
		dir: `/packages/${name}`,
		deps: new Set(deps),
	});

	test('publishes a dependency before the package that needs it', () => {
		const order = inDependencyOrder([
			pkg('@nxgt/app', ['@nxgt/core']),
			pkg('@nxgt/core'),
			pkg('@nxgt/plugin', ['@nxgt/app']),
		]);
		expect(order.map((p) => p.name)).toEqual([
			'@nxgt/core',
			'@nxgt/app',
			'@nxgt/plugin',
		]);
	});

	test('a dependency outside the workspace waits for nothing', () => {
		const order = inDependencyOrder([pkg('@nxgt/one', ['@nxgt/elsewhere'])]);
		expect(order.map((p) => p.name)).toEqual(['@nxgt/one']);
	});

	test('names the packages in a cycle rather than looping', () => {
		expect(() =>
			inDependencyOrder([
				pkg('@nxgt/a', ['@nxgt/b']),
				pkg('@nxgt/b', ['@nxgt/a']),
			]),
		).toThrow('dependency cycle between: @nxgt/a, @nxgt/b');
	});
});
