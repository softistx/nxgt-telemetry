import { describe, expect, test } from 'bun:test';
import { declarationSpecifiers } from './declarations';

describe('declarationSpecifiers', () => {
	test('reads every form tsc emits', () => {
		expect(
			declarationSpecifiers(
				[
					'/// <reference types="a" />',
					"import type { B } from 'b';",
					'import { C } from "c";',
					"import 'd';",
					"export * from 'e';",
					"export * as f from 'f';",
					"export type { G } from 'g';",
					"export { H } from './h';",
					"export type I = import('i').I;",
					"import J = require('j');",
				].join('\n'),
			).sort(),
		).toEqual(['./h', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'i', 'j']);
	});

	test('a specifier inside a JSDoc comment or a string literal type is no import', () => {
		expect(
			declarationSpecifiers(
				[
					'/**',
					" * @example import { defineCache } from '@nxgt/redis';",
					" * const x = await import('@nxgt/redis-guard');",
					' */',
					"// import '@nxgt/s3';",
					'export type Example = "import { A } from \'not-a-module\'";',
					"export declare const url: 'http://example.com/x';",
					"export type { Reply } from './protocol/reply';",
				].join('\n'),
			),
		).toEqual(['./protocol/reply']);
	});

	test('reads the forms a stricter scanner would miss', () => {
		expect(
			declarationSpecifiers(
				[
					"export type K = import('k', { with: { 'resolution-mode': 'import' } }).K;",
					// A template literal type, its substitutions written out: '$' + '{'
					`export type L = \`${'$'}{import('l').Prefix}-${'$'}{string}\`;`,
					'export { "a-b" as ab } from \'m\';',
					"import type N = require('n');",
				].join('\n'),
			).sort(),
		).toEqual(['k', 'l', 'm', 'n']);
	});

	test('a reference counts only among the leading comments, as for tsc', () => {
		expect(
			declarationSpecifiers(
				[
					'/*',
					'/// <reference types="in-block" />',
					'*/',
					'  /// <reference types="leading" />',
					'/// <reference resolution-mode="import" types="attribute-second" />',
					'export type T = `',
					'/// <reference types="in-template" />',
					'`;',
					'/// <reference types="after-code" />',
					'export type U = 1; /// <reference types="same-line" />',
				].join('\n'),
			),
		).toEqual(['leading', 'attribute-second']);
	});

	test('a leading #! line hides no reference', () => {
		expect(
			declarationSpecifiers(
				'#!/usr/bin/env node\n/// <reference types="shebang" />\nexport {};',
			),
		).toEqual(['shebang']);
	});

	test('reads a module augmentation, not the ambient module of a script', () => {
		expect(
			declarationSpecifiers(
				"import type { A } from './a';\ndeclare module '@nxgt/redis' {\n\texport interface X {}\n}",
			).sort(),
		).toEqual(['./a', '@nxgt/redis']);
		expect(
			declarationSpecifiers(
				"declare module 'ambient' {\n\texport type T = import('inner').T;\n}",
			),
		).toEqual(['inner']);
		expect(
			declarationSpecifiers(
				"declare module 'x' {}\ntype T = import('y').T;",
			).sort(),
		).toEqual(['x', 'y']);
	});

	test('string escapes are decoded', () => {
		expect(
			declarationSpecifiers(
				"import type { A } from '\\u0061';\nimport type { B } from '\\x62\\u{63}';",
			),
		).toEqual(['a', 'bc']);
	});

	test('a line continuation and a legacy octal read as JavaScript reads them', () => {
		expect(
			declarationSpecifiers(
				"import type { A } from 'a\\\nb';\nimport type { C } from '\\101';",
			),
		).toEqual(['ab', 'A']);
	});

	test('an unclosed \\u{ stays in its string and swallows nothing after it', () => {
		expect(
			declarationSpecifiers(
				"export type V = '\\u{61';\nimport type { B } from 'b';",
			),
		).toEqual(['b']);
	});

	test('an escaped quote does not end a string early', () => {
		expect(
			declarationSpecifiers(
				"export type Q = 'it\\'s from \\'x\\'';\nimport type { Y } from 'y';",
			),
		).toEqual(['y']);
	});
});
