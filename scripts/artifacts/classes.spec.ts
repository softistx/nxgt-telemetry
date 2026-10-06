import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duplicateClasses } from './classes';

describe('duplicateClasses', () => {
	const dirs: string[] = [];
	afterAll(() =>
		Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))),
	);

	test('finds a class defined in two entry bundles', () => {
		expect(
			duplicateClasses([
				[
					'index.js',
					'class DataError extends Error {}\nclass NotFoundError {}',
				],
				['pg/index.js', 'class NotFoundError {}'],
			]),
		).toEqual([['NotFoundError', ['index.js', 'pg/index.js']]]);
	});

	test('does not count a shared chunk: that is the fix, not the symptom', () => {
		expect(
			duplicateClasses([
				['chunks/errors-abc.js', 'class NotFoundError {}'],
				['index.js', 'import "./chunks/errors-abc.js";'],
				['pg/index.js', 'import "../chunks/errors-abc.js";'],
			]),
		).toEqual([]);
	});

	test('reads only definitions at the start of a line, not a mention', () => {
		expect(
			duplicateClasses([
				['a.js', 'class Thing {}'],
				['b.js', '// the class Thing lives in a.js\nconst x = new Thing();'],
			]),
		).toEqual([]);
	});

	test('catches what Bun.build does without splitting, and passes what it does with it', async () => {
		// Measured, not assumed: two entry points sharing one class module.
		const dir = await mkdtemp(join(tmpdir(), 'nxgt-data-splitting-'));
		dirs.push(dir);
		await writeFile(
			join(dir, 'errors.ts'),
			'export class NotFoundError extends Error {}\n',
		);
		await writeFile(
			join(dir, 'a.ts'),
			"export { NotFoundError } from './errors';\n",
		);
		await writeFile(
			join(dir, 'b.ts'),
			"export { NotFoundError } from './errors';\n",
		);

		const bundles = async (splitting: boolean) => {
			const out = join(dir, splitting ? 'split' : 'inline');
			const result = await Bun.build({
				entrypoints: [join(dir, 'a.ts'), join(dir, 'b.ts')],
				outdir: out,
				splitting,
				naming: { chunk: 'chunks/[name]-[hash].[ext]' },
			});
			expect(result.success).toBe(true);
			const files: [string, string][] = [];
			for await (const rel of new Bun.Glob('**/*.js').scan({ cwd: out })) {
				files.push([rel, await Bun.file(join(out, rel)).text()]);
			}
			return files;
		};

		expect(duplicateClasses(await bundles(false)).map(([cls]) => cls)).toEqual([
			'NotFoundError',
		]);
		expect(duplicateClasses(await bundles(true))).toEqual([]);
	});
});
