import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { declarationSpecifiers } from './declarations';
import { isRuntime, packageOf, RUNTIME_FIELDS } from './imports';
import type { Pkg } from './packages';
import { type Installed, shipsTypes, subpathOf } from './resolve-types';

export type { Installed };

/** Why an import's types do not reach a consumer. */
export type Reason = 'no types' | 'not installed';

/** The DefinitelyTyped package for a name: `@scope/x` is `@types/scope__x`. */
export function typesPackageOf(name: string): string {
	return `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;
}

/**
 * Every package a built declaration file imports whose types would not reach
 * a consumer: it ships none, and its `@types` package is not in
 * `dependencies`, `peerDependencies` or `optionalDependencies`. A
 * devDependency never counts: no consumer installs it. The runtime's own
 * (`bun`, `bun:*`, Node's built-ins) is left to the consumer's `@types/bun`
 * or `@types/node`, as every package here assumes, and so is
 * `/// <reference types="node" />`; relative imports and the package itself
 * pass. Each import is read for its own subpath (`shipsTypes`). One
 * `lookup` cannot find is reported as not installed. Only `.d.ts` files are
 * read, not a `.d.mts` or `.d.cts` a build emits, as in `imports.ts`. Pure,
 * so it has specs.
 */
export function typelessImports(
	manifest: { name: string } & Partial<
		Record<(typeof RUNTIME_FIELDS)[number], Record<string, string>>
	>,
	bundles: Iterable<readonly [rel: string, text: string]>,
	lookup: (name: string) => Installed | undefined,
): [file: string, specifier: string, reason: Reason][] {
	const declared = new Set<string>();
	for (const field of RUNTIME_FIELDS) {
		for (const name of Object.keys(manifest[field] ?? {})) declared.add(name);
	}
	const found: [string, string, Reason][] = [];
	for (const [rel, text] of bundles) {
		if (!rel.endsWith('.d.ts')) continue;
		for (const path of declarationSpecifiers(text)) {
			if (
				path.startsWith('.') ||
				path.startsWith('/') ||
				path === 'node' ||
				isRuntime(path)
			) {
				continue;
			}
			const name = packageOf(path);
			if (name === manifest.name || declared.has(typesPackageOf(name))) {
				continue;
			}
			const pkg = lookup(name);
			if (!pkg) found.push([rel, path, 'not installed']);
			else if (!shipsTypes(pkg, subpathOf(path)))
				found.push([rel, path, 'no types']);
		}
	}
	return found;
}

/**
 * A package as the consumer's tsc resolves it from the package that imports
 * it: Node's lookup, each `node_modules` from that package's real folder up,
 * so a hoisted install and an isolated one (where the folder is a symlink
 * into `node_modules/.bun`) both resolve. It stops at the install's own
 * folder: what sits above it is this machine's, not the consumer's.
 */
function installedFrom(
	workdir: string,
	from: string,
	name: string,
): Installed | undefined {
	const top = realpathSync(workdir);
	let at = realpathSync(join(workdir, 'node_modules', from));
	for (;;) {
		const dir = join(at, 'node_modules', name);
		const manifest = join(dir, 'package.json');
		if (existsSync(manifest)) {
			return {
				manifest: JSON.parse(readFileSync(manifest, 'utf8')),
				has: (rel) => existsSync(join(dir, rel)),
			};
		}
		if (at === top || dirname(at) === at) return undefined;
		at = dirname(at);
	}
}

/**
 * Every package a built `.d.ts` imports resolves types for a consumer,
 * checked on the installed tarballs; false if any does not.
 *
 * `importsDeclared` proves the package reaches the consumer; this proves its
 * types do. A dependency with no types of its own, whose `@types` package is
 * only a devDependency, passes every other check here, since the workspace
 * installs devDependencies, and gives the consumer TS7016 under
 * `skipLibCheck: false` or a silent `any` under `skipLibCheck: true`
 * (nxgt-core's `@nxgt/shared` and `nodemailer`, softistx/nxgt-core#194).
 * A package the install does not hold, an optional peer on no registry,
 * cannot be read and is reported as skipped, not failed.
 */
export async function typesReachConsumer(
	workdir: string,
	packages: readonly Pkg[],
): Promise<boolean> {
	console.log(
		"\nChecking every declaration import's types reach a consumer…\n",
	);
	let typeless = 0;
	for (const pkg of packages) {
		const root = join(workdir, 'node_modules', pkg.name);
		const manifest = await Bun.file(join(root, 'package.json')).json();
		const bundles: [string, string][] = [];
		for await (const rel of new Bun.Glob('dist/**/*.d.ts').scan({
			cwd: root,
			onlyFiles: true,
		})) {
			bundles.push([rel, await Bun.file(join(root, rel)).text()]);
		}
		const found = typelessImports(manifest, bundles, (name) =>
			installedFrom(workdir, pkg.name, name),
		);
		let failed = false;
		for (const [file, specifier, reason] of found) {
			if (reason === 'not installed') {
				console.log(
					`  skip    ${pkg.name}: ${file} imports "${specifier}", not installed here`,
				);
				continue;
			}
			failed = true;
			console.log(
				`  FAIL    ${pkg.name}: ${file} imports "${specifier}", which ships ` +
					`no types, and ${typesPackageOf(packageOf(specifier))} is not declared`,
			);
		}
		if (failed) typeless++;
		else console.log(`  ok      ${pkg.name}`);
	}
	if (typeless > 0) {
		console.error(
			`\n${typeless} package(s) ship declarations importing a package whose ` +
				'types no\nconsumer installs: tsc reports TS7016, or under ' +
				'skipLibCheck the type is a\nsilent `any`. Declare its @types ' +
				'package in dependencies. See AGENTS.md.',
		);
		return false;
	}
	console.log(
		`\nEvery declaration import's types reach a consumer in all ${packages.length} packages.`,
	);
	return true;
}
