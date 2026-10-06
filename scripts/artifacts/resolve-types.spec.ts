import { describe, expect, test } from 'bun:test';
import { type Installed, shipsTypes, subpathOf } from './resolve-types';

/** A package as installed: its manifest and the files its folder holds. */
function installed(
	manifest: Record<string, unknown>,
	files: readonly string[] = [],
): Installed {
	const held = new Set(files);
	return { manifest, has: (rel) => held.has(rel.replace(/^\.\//, '')) };
}

describe('subpathOf', () => {
	test("reads the subpath exports keys it under, '.' for the package", () => {
		expect(subpathOf('yargs')).toBe('.');
		expect(subpathOf('yargs/browser')).toBe('./browser');
		expect(subpathOf('@babel/core')).toBe('.');
		expect(subpathOf('@babel/core/lib/x.js')).toBe('./lib/x.js');
	});
});

describe('shipsTypes, without exports', () => {
	test('reads a types or typings field whose file is there', () => {
		expect(
			shipsTypes(
				installed({ types: './dist/index.d.ts' }, ['dist/index.d.ts']),
			),
		).toBe(true);
		expect(
			shipsTypes(installed({ typings: 'lib/main.d.ts' }, ['lib/main.d.ts'])),
		).toBe(true);
		expect(shipsTypes(installed({ types: './dist/index.d.ts' }))).toBe(false);
	});

	test('reads an extensionless types or main as tsc does', () => {
		// @kwsites/promise-deferred 1.1.1 and abort-controller 3.0.0
		expect(
			shipsTypes(installed({ types: './dist/index' }, ['dist/index.d.ts'])),
		).toBe(true);
		expect(
			shipsTypes(
				installed({ main: 'dist/abort-controller' }, [
					'dist/abort-controller.js',
					'dist/abort-controller.d.ts',
				]),
			),
		).toBe(true);
		expect(shipsTypes(installed({ typings: 'lib' }, ['lib/index.d.ts']))).toBe(
			true,
		);
		expect(
			shipsTypes(installed({ main: 'dist/abort-controller' }, ['dist/x.d.ts'])),
		).toBe(false);
	});

	test('reads a declaration file beside main, an index.d.ts and typesVersions', () => {
		expect(
			shipsTypes(
				installed({ main: 'lib/x.cjs' }, ['lib/x.cjs', 'lib/x.d.cts']),
			),
		).toBe(true);
		expect(shipsTypes(installed({}, ['index.d.ts']))).toBe(true);
		expect(shipsTypes(installed({ typesVersions: { '*': {} } }))).toBe(true);
	});

	test('reads a subpath as a file in the package', () => {
		const pkg = installed({ main: 'index.js' }, [
			'index.js',
			'upload.mjs',
			'upload.d.mts',
			'lib/a.d.ts',
			'bare.js',
		]);
		expect(shipsTypes(pkg, './upload.mjs')).toBe(true);
		expect(shipsTypes(pkg, './lib/a')).toBe(true);
		expect(shipsTypes(pkg, './bare.js')).toBe(false);
	});

	test('refuses a package that ships JavaScript alone', () => {
		expect(
			shipsTypes(installed({ main: 'lib/index.js' }, ['lib/index.js'])),
		).toBe(false);
	});
});

describe('shipsTypes, with exports', () => {
	test("reads the entry of the specifier's subpath only, as yargs needs", () => {
		// yargs 18.1.0: a types condition on ./browser alone
		const yargs = installed(
			{
				types: './browser.d.ts',
				exports: {
					'.': { import: './index.mjs', require: './index.cjs' },
					'./browser': { types: './browser.d.ts', import: './browser.mjs' },
				},
			},
			['index.mjs', 'index.cjs', 'browser.mjs', 'browser.d.ts'],
		);
		expect(shipsTypes(yargs)).toBe(false);
		expect(shipsTypes(yargs, './browser')).toBe(true);
		expect(shipsTypes(yargs, './helpers')).toBe(false);
	});

	test('reads a types condition, nested, whose file is there', () => {
		const exports = {
			'.': { import: { types: './a.d.mts', default: './a.mjs' } },
		};
		expect(shipsTypes(installed({ exports }, ['a.mjs', 'a.d.mts']))).toBe(true);
		expect(shipsTypes(installed({ exports }, ['a.mjs']))).toBe(false);
	});

	test('reads conditions or a string at the top as the entry of .', () => {
		expect(
			shipsTypes(
				installed({ exports: { types: './i.d.ts', default: './i.js' } }, [
					'i.d.ts',
				]),
			),
		).toBe(true);
		expect(
			shipsTypes(installed({ exports: './i.js' }, ['i.js', 'i.d.ts'])),
		).toBe(true);
		expect(
			shipsTypes(installed({ exports: './i.js' }, ['i.js', 'i.d.ts']), './x'),
		).toBe(false);
	});

	test('reads a declaration file beside a target, .d.mts beside .mjs', () => {
		const exports = { './upload.mjs': './upload.mjs' };
		expect(
			shipsTypes(
				installed({ exports }, ['upload.mjs', 'upload.d.mts']),
				'./upload.mjs',
			),
		).toBe(true);
		expect(
			shipsTypes(installed({ exports }, ['upload.mjs']), './upload.mjs'),
		).toBe(false);
	});

	test('reads a * pattern, its key and its target', () => {
		const typed = installed(
			{ exports: { './*': { types: './types/*.d.ts', default: './*.js' } } },
			['types/a.d.ts', 'a.js', 'b.js'],
		);
		expect(shipsTypes(typed, './a')).toBe(true);
		expect(shipsTypes(typed, './b')).toBe(false);
		const beside = installed({ exports: { './*': './dist/*.js' } }, [
			'dist/a.js',
			'dist/a.d.ts',
		]);
		expect(shipsTypes(beside, './a')).toBe(true);
		expect(shipsTypes(beside, './c')).toBe(false);
	});

	test('takes the exact key before a pattern', () => {
		const pkg = installed(
			{
				exports: {
					'./*': { types: './t/*.d.ts' },
					'./a': './a.js',
				},
			},
			['t/a.d.ts', 'a.js'],
		);
		expect(shipsTypes(pkg, './a')).toBe(false);
	});

	test('ignores main, types and index.d.ts once exports is there', () => {
		expect(
			shipsTypes(
				installed({ types: 'index.d.ts', exports: { '.': './lib/index.js' } }, [
					'index.d.ts',
					'lib/index.js',
				]),
			),
		).toBe(false);
	});
});

describe('shipsTypes, the conditions tsc matches under bundler', () => {
	const at = (entry: unknown, files: string[]) =>
		shipsTypes(installed({ exports: { '.': entry } }, files));

	test('counts types under import or default', () => {
		expect(at({ import: { types: './x.d.ts' } }, ['x.d.ts'])).toBe(true);
		expect(at({ default: { types: './x.d.ts' } }, ['x.d.ts'])).toBe(true);
	});

	test('ignores types only under require, browser or node', () => {
		expect(at({ require: { types: './x.d.ts' } }, ['x.d.ts'])).toBe(false);
		expect(at({ browser: './x.js' }, ['x.js', 'x.d.ts'])).toBe(false);
		expect(at({ node: { types: './x.d.ts' } }, ['x.d.ts'])).toBe(false);
	});

	test('stops at a matched null, as @mswjs/interceptors 0.41.9 has', () => {
		const pkg = installed(
			{
				exports: {
					'./presets/browser': {
						browser: './lib/browser/presets/browser.mjs',
						node: null,
						import: null,
						default: './lib/browser/presets/browser.mjs',
					},
				},
			},
			['lib/browser/presets/browser.mjs', 'lib/browser/presets/browser.d.mts'],
		);
		expect(shipsTypes(pkg, './presets/browser')).toBe(false);
	});

	test('reads a types condition whose value is conditions, as fraction.js 5.3.4', () => {
		const entry = {
			types: { import: './x.d.mts', require: './x.d.ts' },
			default: './x.cjs',
		};
		expect(at(entry, ['x.cjs', 'x.d.mts'])).toBe(true);
		expect(at(entry, ['x.cjs', 'x.d.ts'])).toBe(false);
	});

	test('takes a TypeScript source as a target, as @react-router/dev 8.4.0', () => {
		expect(at('./src/index.ts', ['src/index.ts'])).toBe(true);
		expect(at({ types: './src/index.tsx' }, ['src/index.tsx'])).toBe(true);
		expect(at({ import: './src/index.mts' }, ['src/index.mts'])).toBe(true);
		expect(at('./src/index.ts', [])).toBe(false);
	});

	test('breaks a tie of prefixes by the longer key, as comparePatternKeys', () => {
		const pkg = installed(
			{
				exports: {
					'./a/*': { types: './t/*.d.ts' },
					'./a/*.js': './a/*.js',
				},
			},
			['t/x.js.d.ts', 'a/x.js'],
		);
		expect(shipsTypes(pkg, './a/x.js')).toBe(false);
	});
});
