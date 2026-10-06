import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'bun';
import { type Pkg, ROOT } from './packages';

/** Where a package keeps the files a consumer's declaration build must name. */
export const FIXTURES = join('test', 'declarations');

/** What a declaration build of one fixture folder answered. */
export type Emitted = { exitCode: number; output: string };

/** Runs a declaration build in `dir`, which holds a fixture and its tsconfig. */
export type Tsc = (dir: string) => Promise<Emitted>;

/** The packages that hold a `test/declarations/` folder. */
export function withFixtures<P extends Pick<Pkg, 'dir'>>(
	packages: readonly P[],
): P[] {
	return packages.filter((p) => existsSync(join(p.dir, FIXTURES)));
}

/** The `tsc` the consumer install holds, run under Bun. */
export function installedTsc(workdir: string): Tsc {
	return async (dir) => {
		const ran =
			await $`bun --bun ${join(workdir, 'node_modules/.bin/tsc')} -p .`
				.cwd(dir)
				.quiet()
				.nothrow();
		return {
			exitCode: ran.exitCode,
			output: ran.stdout.toString() + ran.stderr.toString(),
		};
	};
}

/**
 * Emits the declarations of each package's `test/declarations/*.ts` against
 * the installed tarballs; false if one fails.
 *
 * A consumer that exports a value whose type is inferred from a package's
 * builder writes a declaration whose types must be named through the
 * package's own entry. A type the entry does not export fails there with
 * TS2883 ("cannot be named without a reference to …"), and only there:
 * inside the workspace a package resolves to its own folder through a
 * symlink, so tsc names the type by a relative path and nothing complains,
 * even with the declaration build on.
 */
export async function declarationsEmit(
	workdir: string,
	packages: readonly Pick<Pkg, 'name' | 'dir'>[],
	tsc: Tsc = installedTsc(workdir),
): Promise<boolean> {
	const fixtures = withFixtures(packages);
	if (fixtures.length === 0) return true;
	console.log(
		`\nEmitting declarations for ${fixtures.length} package(s)' fixtures…\n`,
	);
	let broken = 0;
	for (const pkg of fixtures) {
		const dir = join(workdir, 'declarations', pkg.name.replace('/', '__'));
		await mkdir(dir, { recursive: true });
		await cp(join(pkg.dir, FIXTURES), dir, {
			recursive: true,
			filter: (source) => !source.endsWith('tsconfig.json'),
		});
		await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG));
		const { exitCode, output } = await tsc(dir);
		const ok = exitCode === 0;
		if (!ok) broken++;
		console.log(`  ${ok ? 'ok  ' : 'FAIL'}    ${pkg.name}`);
		if (!ok) console.log(indent(output));
	}
	if (broken > 0) {
		console.error(
			`\n${broken} package(s)' fixtures do not emit their declarations.\n` +
				'A TS2883 names a type the package entry must export; any other\n' +
				'error is a fixture that no longer compiles. See AGENTS.md.',
		);
		return false;
	}
	console.log('\nEvery fixture emits its declarations.');
	return true;
}

/**
 * A consumer's strict settings, with the declaration build on. Bun's types
 * come from this repository's own `@types/bun`, as a Bun consumer has them:
 * without them a type a package takes from `bun` or `node:*`, such as
 * `RedisClient`, would be an error type that `skipLibCheck` hides, and emit
 * as a name the `.d.ts` does not import.
 */
export const TSCONFIG = {
	compilerOptions: {
		types: ['bun'],
		typeRoots: [join(ROOT, 'node_modules', '@types')],
		lib: ['ESNext', 'DOM'],
		target: 'ESNext',
		module: 'ESNext',
		moduleResolution: 'bundler',
		strict: true,
		exactOptionalPropertyTypes: true,
		noUncheckedIndexedAccess: true,
		declaration: true,
		emitDeclarationOnly: true,
		outDir: 'out',
		skipLibCheck: true,
	},
	include: ['**/*.ts'],
	exclude: ['out'],
};

function indent(text: string): string {
	return text
		.trim()
		.split('\n')
		.map((line) => `            ${line}`)
		.join('\n');
}
