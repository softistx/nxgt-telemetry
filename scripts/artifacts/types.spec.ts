import { describe, expect, test } from 'bun:test';
import { type Installed, typelessImports, typesPackageOf } from './types';

/** A package as installed: its manifest and the files its folder holds. */
function installed(
	manifest: Record<string, unknown>,
	files: readonly string[] = [],
): Installed {
	const held = new Set(files);
	return { manifest, has: (rel) => held.has(rel.replace(/^\.\//, '')) };
}

describe('typesPackageOf', () => {
	test('maps a plain name and a scoped one to their @types package', () => {
		expect(typesPackageOf('nodemailer')).toBe('@types/nodemailer');
		expect(typesPackageOf('@babel/core')).toBe('@types/babel__core');
	});
});

describe('typelessImports', () => {
	const shared = { name: '@nxgt/shared' };
	const nodemailer = installed({ main: 'lib/nodemailer.js' }, [
		'lib/nodemailer.js',
	]);
	const mailer: [string, string] = [
		'dist/types/mailer.d.ts',
		"import type { Transporter } from 'nodemailer';\nexport type M = Transporter;",
	];

	test('flags a typeless package whose @types is only a devDependency', () => {
		const manifest = {
			...shared,
			dependencies: { nodemailer: '^7.0.0' },
			devDependencies: { '@types/nodemailer': '^7.0.0' },
		};
		expect(
			typelessImports(manifest, [mailer], (name) =>
				name === 'nodemailer' ? nodemailer : undefined,
			),
		).toEqual([['dist/types/mailer.d.ts', 'nodemailer', 'no types']]);
	});

	test('passes @types declared in dependencies, peers or optional ones', () => {
		for (const field of [
			'dependencies',
			'peerDependencies',
			'optionalDependencies',
		]) {
			expect(
				typelessImports(
					{
						...shared,
						dependencies: { nodemailer: '^7.0.0' },
						[field]: { nodemailer: '^7.0.0', '@types/nodemailer': '^7.0.0' },
					},
					[mailer],
					() => nodemailer,
				),
			).toEqual([]);
		}
	});

	test('passes a package that ships its own types', () => {
		expect(
			typelessImports(
				{ ...shared, peerDependencies: { zod: '^4.0.0' } },
				[['dist/a.d.ts', "export type { ZodType } from 'zod/v4';"]],
				() =>
					installed({ exports: { './v4': { types: './v4/index.d.ts' } } }, [
						'v4/index.d.ts',
					]),
			),
		).toEqual([]);
	});

	test('maps a scoped package to @types/scope__name', () => {
		const babel: [string, string] = [
			'dist/a.d.ts',
			"import type { PluginObj } from '@babel/core';\nexport type P = PluginObj;",
		];
		const bare = installed({ main: 'lib/index.js' }, ['lib/index.js']);
		expect(
			typelessImports(
				{
					...shared,
					dependencies: { '@babel/core': '^7', '@types/babel__core': '^7' },
				},
				[babel],
				() => bare,
			),
		).toEqual([]);
		expect(
			typelessImports(
				{ ...shared, dependencies: { '@babel/core': '^7' } },
				[babel],
				() => bare,
			),
		).toEqual([['dist/a.d.ts', '@babel/core', 'no types']]);
	});

	test('skips the runtime, relative files, the package itself and .js', () => {
		expect(
			typelessImports(
				shared,
				[
					[
						'dist/a.d.ts',
						[
							'/// <reference types="bun" />',
							"import type { Readable } from 'node:stream';",
							"import type { EventEmitter } from 'events';",
							"import type { Server } from 'bun';",
							"import type { Reply } from './reply';",
							"export type { X } from '@nxgt/shared/types';",
						].join('\n'),
					],
					['dist/a.js', 'import "nodemailer";'],
				],
				() => nodemailer,
			),
		).toEqual([]);
	});

	test('reports a package that is not installed, since nothing can say', () => {
		expect(
			typelessImports(
				{ ...shared, peerDependencies: { ghost: '1' } },
				[['dist/a.d.ts', "export type { G } from 'ghost';"]],
				() => undefined,
			),
		).toEqual([['dist/a.d.ts', 'ghost', 'not installed']]);
	});
	test('flags an import of a subpath that is untyped, as yargs is', () => {
		const yargs = installed(
			{
				exports: {
					'.': { import: './index.mjs' },
					'./browser': { types: './browser.d.ts', import: './browser.mjs' },
				},
			},
			['index.mjs', 'browser.mjs', 'browser.d.ts'],
		);
		expect(
			typelessImports(
				{ ...shared, dependencies: { yargs: '^18' } },
				[
					[
						'dist/cli.d.ts',
						"import type { Argv } from 'yargs';\nexport type { B } from 'yargs/browser';",
					],
				],
				() => yargs,
			),
		).toEqual([['dist/cli.d.ts', 'yargs', 'no types']]);
	});

	test('leaves /// <reference types="node" /> to the consumer', () => {
		expect(
			typelessImports(
				shared,
				[['dist/a.d.ts', '/// <reference types="node" />\nexport {};']],
				() => undefined,
			),
		).toEqual([]);
	});
});
