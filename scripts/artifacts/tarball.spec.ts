import { describe, expect, test } from 'bun:test';
import {
	licenseProblems,
	missingFiles,
	TEST_CODE,
	testCodeProblems,
} from './tarball';

describe('licenseProblems', () => {
	test('wants MIT and a LICENSE in the tarball itself', () => {
		expect(
			licenseProblems({ name: 'x', license: 'MIT' }, ['package/LICENSE']),
		).toEqual([]);
		expect(licenseProblems({ name: 'x', license: 'ISC' }, [])).toEqual([
			'x: license is ISC, not MIT',
			'x: the tarball has no LICENSE',
		]);
	});
});

describe('missingFiles', () => {
	const entries = [
		'package/package.json',
		'package/LICENSE',
		'package/README.md',
		'package/dist/index.js',
		'package/docs/guide/getting-started.md',
	];

	test('holds when every files entry is a file or a folder of the tarball', () => {
		expect(
			missingFiles(
				{
					name: 'x',
					files: ['dist', './docs/', 'README.md', 'package.json', 'LICENSE'],
				},
				entries,
			),
		).toEqual([]);
	});

	test('names each entry the tarball holds nothing under', () => {
		expect(
			missingFiles({ name: 'x', files: ['dist', 'doc', 'examples'] }, entries),
		).toEqual([
			'x: files lists doc, which the tarball does not hold — build it first, or drop it from files',
			'x: files lists examples, which the tarball does not hold — build it first, or drop it from files',
		]);
	});

	test('reads a folder by its name, not by a prefix of it', () => {
		expect(
			missingFiles({ name: 'x', files: ['dis'] }, ['package/dist/index.js']),
		).toEqual([
			'x: files lists dis, which the tarball does not hold — build it first, or drop it from files',
		]);
	});

	test('leaves a glob to npm, and a manifest without files alone', () => {
		expect(missingFiles({ name: 'x', files: ['*.md'] }, entries)).toEqual([]);
		expect(missingFiles({ name: 'x' }, entries)).toEqual([]);
	});
});

describe('testCodeProblems', () => {
	const x = { name: 'x' };

	test('refuses a spec, emitted or not', () => {
		expect(
			testCodeProblems(x, [
				'package/src/collection/upsert.spec.ts',
				'package/dist/collection/upsert.spec.d.ts',
			]),
		).toEqual([
			'x: the tarball ships test code: src/collection/upsert.spec.ts',
			'x: the tarball ships test code: dist/collection/upsert.spec.d.ts',
		]);
	});

	test('refuses a fixtures file with a dotted prefix, the one specs share', () => {
		expect(
			testCodeProblems(x, [
				'package/dist/connection/connect.fixtures.d.ts',
				'package/src/connection/connect.fixtures.ts',
			]),
		).toEqual([
			'x: the tarball ships test code: dist/connection/connect.fixtures.d.ts',
			'x: the tarball ships test code: src/connection/connect.fixtures.ts',
		]);
	});

	test('allows a plain fixtures file: a package may ship one on purpose', () => {
		expect(
			testCodeProblems(x, [
				'package/package.json',
				'package/dist/conformance/fixtures.d.ts',
				'package/src/conformance/fixtures.ts',
				'package/dist/index.js',
			]),
		).toEqual([]);
	});

	test('refuses a snapshot, and reads a name, not a folder', () => {
		expect(TEST_CODE.test('src/__snapshots__/a.spec.ts.snap')).toBe(true);
		expect(TEST_CODE.test('dist/specimens/index.js')).toBe(false);
		expect(TEST_CODE.test('dist/a.spec/index.js')).toBe(false);
		expect(TEST_CODE.test('dist/fixtures/index.js')).toBe(false);
	});
});
