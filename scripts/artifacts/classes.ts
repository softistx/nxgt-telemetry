import { join } from 'node:path';
import type { Pkg } from './packages';

/**
 * Every class DEFINED in more than one entry bundle, from the bundles' paths
 * and texts. Files under `chunks/` are skipped: a class defined in one shared
 * chunk is the fix, not the symptom. Pure, so it has specs: the scan is what
 * notices `splitting: true` being taken out of `build.ts`.
 */
export function duplicateClasses(
	bundles: Iterable<readonly [rel: string, text: string]>,
): [cls: string, files: string[]][] {
	const where = new Map<string, string[]>();
	for (const [rel, text] of bundles) {
		if (rel.startsWith('chunks/')) continue;
		for (const match of text.matchAll(/^class ([A-Za-z_$][\w$]*)/gm)) {
			const cls = match[1];
			if (!cls) continue;
			where.set(cls, [...(where.get(cls) ?? []), rel]);
		}
	}
	return [...where].filter(([, files]) => files.length > 1);
}

/**
 * One class per package, checked on the installed tarballs; false if any
 * package defines one twice.
 *
 * A class must be DEFINED once in a package, not once per entry point.
 * `Bun.build` inlines a shared module into every entry bundle unless
 * `splitting` is on, so a package with several entry points can hand an app
 * two copies of one class — and `instanceof` across them is false. It is the
 * failure `packages: 'external'` was chosen to prevent, arriving from the
 * other side: that setting already refuses to duplicate a DEPENDENCY's
 * classes, and this is the same argument for the package's own.
 *
 * This repo already builds with `splitting: true`, and `build.ts` says why.
 * What it did not have is anything that would notice the setting being
 * removed — which is what this is. Found in nxgt-ory, where two copies of
 * `OryUnavailable` meant nine routes answered 500 instead of 503.
 *
 * A scan of the entry bundles rather than a runtime `instanceof` probe,
 * because duplication can be real in the artifact and still unreachable
 * through the export surface — inert today, live the day one more export is
 * added. A runtime probe passes in exactly that case, which is the case that
 * survives longest.
 *
 * Against the INSTALLED TARBALL, like everything else here: that is the only
 * artifact a consumer sees.
 */
export async function classesDefinedOnce(
	workdir: string,
	packages: readonly Pkg[],
): Promise<boolean> {
	console.log('\nChecking each class is defined once per package…\n');
	let duplicated = 0;
	for (const pkg of packages) {
		const dist = join(workdir, 'node_modules', pkg.name, 'dist');
		const bundles: [string, string][] = [];
		for await (const rel of new Bun.Glob('**/*.js').scan({
			cwd: dist,
			onlyFiles: true,
		})) {
			bundles.push([rel, await Bun.file(join(dist, rel)).text()]);
		}
		const twice = duplicateClasses(bundles);
		if (twice.length === 0) {
			console.log(`  ok      ${pkg.name}`);
			continue;
		}
		duplicated++;
		for (const [cls, files] of twice) {
			console.log(`  FAIL    ${pkg.name}: ${cls} in ${files.join(', ')}`);
		}
	}
	if (duplicated > 0) {
		console.error(
			`\n${duplicated} package(s) define a class more than once. An ` +
				'`instanceof` across\ntwo entry points of such a package is false, and ' +
				'nothing else reports it —\nit typechecks, and every subpath loads. ' +
				'`splitting: true` in build.ts is what\nshares them; see its comment.',
		);
		return false;
	}
	console.log(
		`\nEach class is defined once in all ${packages.length} packages.`,
	);
	return true;
}
