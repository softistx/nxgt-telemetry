import { describe, expect, test } from 'bun:test';
import { packageOf, undeclaredImports } from './imports';

describe('packageOf', () => {
	test('reads a scoped name and a plain one, without the subpath', () => {
		expect(packageOf('@nxgt/mongo/gridfs')).toBe('@nxgt/mongo');
		expect(packageOf('@nxgt/redis')).toBe('@nxgt/redis');
		expect(packageOf('lodash/fp')).toBe('lodash');
	});
});

describe('undeclaredImports', () => {
	const kit = { name: '@nxgt/mongo-kit' };

	test('refuses a sibling the manifest lists only as a devDependency', () => {
		const manifest = {
			...kit,
			devDependencies: { '@nxgt/redis': 'workspace:^' },
		};
		expect(
			undeclaredImports(manifest, [
				[
					'dist/index.js',
					'import { defineCache } from "@nxgt/redis";\nexport { defineCache };',
				],
			]),
		).toEqual([['dist/index.js', '@nxgt/redis']]);
	});

	test('passes the runtime, relative files, chunks and the package itself', () => {
		expect(
			undeclaredImports(kit, [
				[
					'dist/index.js',
					[
						'import { listen } from "bun";',
						'import { Database } from "bun:sqlite";',
						'import { lookup } from "node:dns";',
						'import { readFileSync } from "fs";',
						'import { reply } from "./chunks/reply-abc.js";',
						'import x from "@nxgt/mongo-kit/package.json";',
						'export { listen, Database, lookup, readFileSync, reply, x };',
					].join('\n'),
				],
			]),
		).toEqual([]);
	});

	test('passes a peer, a dependency and an optional dependency', () => {
		expect(
			undeclaredImports(
				{
					...kit,
					peerDependencies: { '@nxgt/mongo': '^0.1.0' },
					dependencies: { a: '1' },
					optionalDependencies: { b: '1' },
				},
				[
					[
						'dist/index.js',
						'import "@nxgt/mongo/migrations";\nimport "a";\nimport "b/sub";',
					],
				],
			),
		).toEqual([]);
	});

	test("reads a bin past its #! line, which Bun's scanner refuses", () => {
		expect(
			undeclaredImports(kit, [
				[
					'dist/cli/index.js',
					'#!/usr/bin/env bun\nimport { main } from "../chunks/main-abc.js";\nimport "left-pad";\nmain();',
				],
			]),
		).toEqual([['dist/cli/index.js', 'left-pad']]);
	});

	test('catches a dynamic import, a require and a re-export too', () => {
		expect(
			undeclaredImports(kit, [
				['dist/a.js', 'export * from "@nxgt/redis";'],
				['dist/b.js', 'export const load = () => import("@nxgt/redis-guard");'],
				['dist/c.js', 'module.exports = require("@nxgt/s3");'],
			]),
		).toEqual([
			['dist/a.js', '@nxgt/redis'],
			['dist/b.js', '@nxgt/redis-guard'],
			['dist/c.js', '@nxgt/s3'],
		]);
	});

	test('catches the type-only imports a declaration file holds', () => {
		expect(
			undeclaredImports(kit, [
				['dist/a.d.ts', "export type { CacheDefinition } from '@nxgt/redis';"],
				[
					'dist/b.d.ts',
					"import type { RateLimit } from '@nxgt/redis-guard';\nexport type J = RateLimit;",
				],
				['dist/c.d.ts', "export type R = import('@nxgt/s3').BucketDefinition;"],
				['dist/d.d.ts', "export type { Reply } from './protocol/reply';"],
				['dist/e.d.ts', '/// <reference types="@nxgt/meilisearch" />'],
				[
					'dist/f.d.ts',
					"import type { Server } from 'bun';\nexport type S = Server;",
				],
			]),
		).toEqual([
			['dist/a.d.ts', '@nxgt/redis'],
			['dist/b.d.ts', '@nxgt/redis-guard'],
			['dist/c.d.ts', '@nxgt/s3'],
			['dist/e.d.ts', '@nxgt/meilisearch'],
		]);
	});
});
