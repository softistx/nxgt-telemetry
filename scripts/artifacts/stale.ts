import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pkg } from './packages';

/**
 * The newest mtime under a directory, or 0 if it does not exist. Deep, because
 * a build is only as fresh as its stalest input.
 */
async function newestMtime(dir: string, skip?: RegExp): Promise<number> {
	// `Bun.Glob().scan` throws ENOENT on a missing `cwd` rather than yielding
	// nothing (measured on bun 1.4.2), so without this an unbuilt package
	// crashed on a filesystem error and never reached the "no dist/" branch
	// of `staleBuilds`, the one that says to run the build.
	const exists = await stat(dir).then(
		(entry) => entry.isDirectory(),
		() => false,
	);
	if (!exists) return 0;

	let newest = 0;
	const glob = new Bun.Glob('**/*');
	for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
		if (skip?.test(rel)) continue;
		const { mtimeMs } = await stat(join(dir, rel));
		if (mtimeMs > newest) newest = mtimeMs;
	}
	return newest;
}

/**
 * Specs, the `<subject>.fixtures.ts` they share, and their snapshots live
 * under `src/` but the build does not emit them, so they cannot make `dist/`
 * stale — and `bun test` rewrites a snapshot
 * file's mtime. CI runs the tests *between* the build and this script, so
 * counting them made a green pipeline fail with
 * `@nxgt/openapi-codegen: src/ is 57s newer than dist/`. Measured on
 * nxgt-http, 2026-09-22. `TEST_CODE` in `tarball.ts` names the same files
 * as the tarball holds them; a new kind of test file belongs in both.
 */
export const NOT_A_BUILD_INPUT =
	/(^|\/)__snapshots__\/|\.(spec|test|fixtures)\.[cm]?[jt]sx?$/;

/**
 * Packages whose `dist/` is missing, or older than their own `src/`.
 *
 * This script packs `dist/` and does not build. CI builds first and so does
 * `changeset:publish`, so only a bare local `bun run verify:artifacts` can
 * verify yesterday's artifact — and `dist/` is gitignored, so the staleness is
 * invisible and cannot be reasoned about from the diff. Measured in `nxgt-core`
 * on 2026-09-22, where it cost an hour: four subpaths failed on `Cannot find
 * package 'stx-sdk'` while the same commit passed in CI, and a *resolution*
 * error sends you to the environment, not to the build.
 */
export async function staleBuilds(
	pkgs: Pick<Pkg, 'name' | 'dir'>[],
): Promise<string[]> {
	const stale: string[] = [];
	for (const pkg of pkgs) {
		const dist = await newestMtime(join(pkg.dir, 'dist'));
		if (dist === 0) {
			stale.push(`${pkg.name}: no dist/`);
			continue;
		}
		const src = await newestMtime(join(pkg.dir, 'src'), NOT_A_BUILD_INPUT);
		if (src > dist) {
			const age = Math.round((src - dist) / 1000);
			stale.push(`${pkg.name}: src/ is ${age}s newer than dist/`);
		}
	}
	return stale;
}
