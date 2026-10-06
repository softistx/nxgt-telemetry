import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import { declarationSpecifiers } from './declarations';
import type { Pkg } from './packages';

/** The fields whose names a built import may reach: what a consumer installs. */
const RUNTIME_FIELDS = [
	'dependencies',
	'peerDependencies',
	'optionalDependencies',
] as const;

/** The package a bare specifier names: `@scope/name` or `name`, no subpath. */
export function packageOf(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@')
		? parts.slice(0, 2).join('/')
		: (parts[0] ?? specifier);
}

/**
 * Whether a specifier is the runtime's own, never a package: `bun`, `bun:*`,
 * and Node's built-ins with or without `node:` (`Bun.build` keeps `"fs"` as
 * written).
 */
function isRuntime(specifier: string): boolean {
	return (
		specifier === 'bun' || specifier.startsWith('bun:') || isBuiltin(specifier)
	);
}

/**
 * The specifiers a file imports. JavaScript goes through Bun's own scanner;
 * a declaration file through `declarationSpecifiers`, since Bun's drops the
 * type-only imports (`import type`, `export type … from`, `import('x').T`,
 * and `/// <reference types>`) that are all a `.d.ts` holds, and a
 * consumer's `tsc` still resolves them.
 */
function specifiersOf(rel: string, text: string): string[] {
	if (rel.endsWith('.d.ts')) return declarationSpecifiers(text);
	// A bin's built file starts with `#!/usr/bin/env bun`, which the scanner
	// refuses as a syntax error, measured on bun 1.4.2 with a built bin's
	// `dist/cli.js`. It is no code: read what follows it.
	return new Bun.Transpiler({ loader: 'js' })
		.scanImports(text.replace(/^#![^\n]*/, ''))
		.map(({ path }) => path);
}

/**
 * Every import in the given bundles that names a package the manifest does
 * not declare, from the bundles' paths and texts. Relative imports, the
 * runtime's own (`bun`, `bun:*`, Node's built-ins with or without `node:`)
 * and the package itself pass; so
 * does anything in `dependencies`, `peerDependencies` or
 * `optionalDependencies`. A devDependency never does: no consumer installs
 * it. Bundles are `.js` or `.d.ts`. Pure, so it has specs.
 *
 * It reads literal specifiers only: `import(variable)`, `require.resolve`,
 * `import.meta.resolve` and `createRequire(…)(…)` are out of its reach.
 */
export function undeclaredImports(
	manifest: { name: string } & Partial<
		Record<(typeof RUNTIME_FIELDS)[number], Record<string, string>>
	>,
	bundles: Iterable<readonly [rel: string, text: string]>,
): [file: string, specifier: string][] {
	const declared = new Set<string>([manifest.name]);
	for (const field of RUNTIME_FIELDS) {
		for (const name of Object.keys(manifest[field] ?? {})) declared.add(name);
	}
	const found: [string, string][] = [];
	for (const [rel, text] of bundles) {
		for (const path of specifiersOf(rel, text)) {
			if (path.startsWith('.') || path.startsWith('/') || isRuntime(path)) {
				continue;
			}
			if (!declared.has(packageOf(path))) found.push([rel, path]);
		}
	}
	return found;
}

/**
 * Which file the scanner refused, and why: the scan of each bundle again,
 * one at a time, so the report names it rather than the run ending in a
 * stack trace.
 */
export function scanFailure(
	bundles: readonly (readonly [string, string])[],
	error: unknown,
): string {
	for (const [rel, text] of bundles) {
		try {
			specifiersOf(rel, text);
		} catch (each) {
			return `${rel} could not be scanned: ${(each as Error).message}`;
		}
	}
	return `could not be scanned: ${(error as Error).message}`;
}

/**
 * Every built import names something the manifest declares, checked on the
 * installed tarballs; false if any package imports what it does not declare.
 *
 * The install below holds every package of this repository side by side, so
 * a package that imports a sibling it lists only as a devDependency — every
 * kit and bridge here lists its siblings there too, for its specs — still
 * loads there. A consumer who installs that package alone gets "Cannot find
 * package". Only reading the imports catches it; loading cannot.
 */
export async function importsDeclared(
	workdir: string,
	packages: readonly Pkg[],
): Promise<boolean> {
	console.log('\nChecking every built import is declared…\n');
	let undeclared = 0;
	for (const pkg of packages) {
		const root = join(workdir, 'node_modules', pkg.name);
		const manifest = await Bun.file(join(root, 'package.json')).json();
		const bundles: [string, string][] = [];
		for await (const rel of new Bun.Glob('dist/**/*.{js,d.ts}').scan({
			cwd: root,
			onlyFiles: true,
		})) {
			bundles.push([rel, await Bun.file(join(root, rel)).text()]);
		}
		let found: [string, string][];
		try {
			found = undeclaredImports(manifest, bundles);
		} catch (error) {
			undeclared++;
			console.log(`  FAIL    ${pkg.name}: ${scanFailure(bundles, error)}`);
			continue;
		}
		if (found.length === 0) {
			console.log(`  ok      ${pkg.name}`);
			continue;
		}
		undeclared++;
		for (const [file, specifier] of found) {
			console.log(`  FAIL    ${pkg.name}: ${file} imports "${specifier}"`);
		}
	}
	if (undeclared > 0) {
		console.error(
			`\n${undeclared} package(s) import a package their manifest does not ` +
				'declare. It loads\nhere only because every sibling is installed ' +
				'beside it; a consumer gets\n"Cannot find package". Declare it as a ' +
				'peer (and devDependency), or stop\nimporting it. See AGENTS.md.',
		);
		return false;
	}
	console.log(
		`\nEvery built import is declared in all ${packages.length} packages.`,
	);
	return true;
}
