import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	declarationsEmit,
	type Emitted,
	FIXTURES,
	TSCONFIG,
	withFixtures,
} from './emit';

const dirs: string[] = [];
afterAll(() =>
	Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))),
);

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'nxgt-data-emit-'));
	dirs.push(dir);
	return dir;
}

/** A package under `root`, with the fixture files given, if any. */
async function pkg(root: string, name: string, files?: Record<string, string>) {
	const dir = join(root, name.replace('/', '__'));
	await mkdir(dir, { recursive: true });
	if (files) {
		for (const [rel, text] of Object.entries(files)) {
			const path = join(dir, FIXTURES, rel);
			await mkdir(join(path, '..'), { recursive: true });
			await writeFile(path, text);
		}
	}
	return { name, dir };
}

/** Runs `declarationsEmit` with a fake tsc, keeping what it printed. */
async function emit(
	workdir: string,
	packages: { name: string; dir: string }[],
	answer: (dir: string) => Emitted,
) {
	const ran: string[] = [];
	const lines: string[] = [];
	const log = spyOn(console, 'log').mockImplementation((line: string) => {
		lines.push(line);
	});
	const error = spyOn(console, 'error').mockImplementation((line: string) => {
		lines.push(line);
	});
	try {
		const ok = await declarationsEmit(workdir, packages, async (dir) => {
			ran.push(dir);
			return answer(dir);
		});
		return { ok, ran, printed: lines.join('\n') };
	} finally {
		log.mockRestore();
		error.mockRestore();
	}
}

describe('withFixtures', () => {
	test('keeps only the packages that hold test/declarations/', async () => {
		const root = await scratch();
		const a = await pkg(root, '@nxgt/a', { 'app.ts': '' });
		const b = await pkg(root, '@nxgt/b');
		await mkdir(join(b.dir, 'test'), { recursive: true });
		expect(withFixtures([a, b])).toEqual([a]);
	});
});

describe('TSCONFIG', () => {
	test("compiles with Bun's types, from a folder that holds them", () => {
		// Without them, a type from `bun` is an error type skipLibCheck hides.
		const { types, typeRoots } = TSCONFIG.compilerOptions;
		expect(types).toEqual(['bun']);
		expect(typeRoots).toHaveLength(1);
		expect(existsSync(join(typeRoots[0] ?? '', 'bun'))).toBe(true);
	});
});

describe('declarationsEmit', () => {
	test('passes, running nothing, when no package has a fixture', async () => {
		const root = await scratch();
		const { ok, ran } = await emit(root, [await pkg(root, '@nxgt/a')], () => ({
			exitCode: 0,
			output: '',
		}));
		expect(ok).toBe(true);
		expect(ran).toEqual([]);
	});

	test("compiles a copy of each fixture folder under the consumer's settings", async () => {
		const root = await scratch();
		const workdir = await scratch();
		const a = await pkg(root, '@nxgt/a', {
			'app.ts': 'export const a = 1;',
			'nested/more.ts': 'export const b = 2;',
			'tsconfig.json': '{"compilerOptions":{"strict":false}}',
		});
		const { ok, ran } = await emit(workdir, [a], () => ({
			exitCode: 0,
			output: '',
		}));
		expect(ok).toBe(true);
		const dir = join(workdir, 'declarations', '@nxgt__a');
		expect(ran).toEqual([dir]);
		expect((await readdir(dir)).sort()).toEqual([
			'app.ts',
			'nested',
			'tsconfig.json',
		]);
		expect(existsSync(join(dir, 'nested', 'more.ts'))).toBe(true);
		// The fixture's own tsconfig never loosens the consumer's.
		expect(await Bun.file(join(dir, 'tsconfig.json')).json()).toEqual(TSCONFIG);
	});

	test('fails, naming each broken package with what tsc said', async () => {
		const root = await scratch();
		const workdir = await scratch();
		const good = await pkg(root, '@nxgt/good', { 'app.ts': '' });
		const bad = await pkg(root, '@nxgt/bad', { 'app.ts': '' });
		const ts2883 =
			"app.ts(3,17): error TS2883: The inferred type of 'app' cannot be named without a reference to 'Hidden'.";
		const { ok, printed } = await emit(workdir, [good, bad], (dir) =>
			dir.endsWith('@nxgt__bad')
				? { exitCode: 2, output: `${ts2883}\n` }
				: { exitCode: 0, output: '' },
		);
		expect(ok).toBe(false);
		expect(printed).toContain('ok      @nxgt/good');
		expect(printed).toContain('FAIL    @nxgt/bad');
		expect(printed).toContain(`            ${ts2883}`);
		expect(printed).toContain(
			"1 package(s)' fixtures do not emit their declarations.",
		);
		expect(printed).toContain(
			'any other\nerror is a fixture that no longer compiles',
		);
	});
});
