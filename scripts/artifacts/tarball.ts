import { $ } from 'bun';

export type Tarball = {
	manifest: Record<string, unknown>;
	/** Every path in the tarball, `package/` prefix included. */
	entries: string[];
};

/** A packed tarball's `package.json` and the list of what it holds. */
export async function readTarball(tgz: string): Promise<Tarball> {
	const raw = await $`tar -xzOf ${tgz} package/package.json`.quiet().text();
	const listing = await $`tar -tzf ${tgz}`.quiet().text();
	return {
		manifest: JSON.parse(raw),
		entries: listing.split('\n').filter(Boolean),
	};
}

/** Every check on what one tarball holds, as opposed to what it declares. */
export function tarballProblems({ manifest, entries }: Tarball): string[] {
	return [
		...licenseProblems(manifest, entries),
		...missingFiles(manifest, entries),
		...testCodeProblems(manifest, entries),
	];
}

/** A license other than MIT, or no `LICENSE` among the tarball's entries. */
export function licenseProblems(
	manifest: Record<string, unknown>,
	entries: readonly string[],
): string[] {
	const problems: string[] = [];
	if (manifest.license !== 'MIT') {
		problems.push(`${manifest.name}: license is ${manifest.license}, not MIT`);
	}
	if (!entries.includes('package/LICENSE')) {
		problems.push(`${manifest.name}: the tarball has no LICENSE`);
	}
	return problems;
}

/**
 * Each `files` entry the tarball holds nothing under: neither the file itself
 * nor anything in the folder it names. Every package here lists `dist` and
 * `docs`; a folder renamed or deleted, or an entry mistyped, would otherwise
 * publish without a word, since npm skips a `files` entry that matches
 * nothing. A glob is left to npm, unread.
 */
export function missingFiles(
	manifest: Record<string, unknown>,
	entries: readonly string[],
): string[] {
	const files: unknown[] = Array.isArray(manifest.files) ? manifest.files : [];
	return files
		.filter((entry): entry is string => typeof entry === 'string')
		.filter((entry) => !/[*?[{!]/.test(entry))
		.map((entry) => entry.replace(/^\.\//, '').replace(/\/+$/, ''))
		.filter(
			(entry) =>
				!entries.some(
					(path) =>
						path === `package/${entry}` || path.startsWith(`package/${entry}/`),
				),
		)
		.map(
			(entry) =>
				`${manifest.name}: files lists ${entry}, which the tarball does not hold — build it first, or drop it from files`,
		);
}

/**
 * A spec, a snapshot, or the `<subject>.fixtures.ts` specs share, emitted or
 * not. The dotted prefix is what tells a spec's fixtures from a shipped one:
 * a plain `fixtures.ts` may be a module a consumer runs, as nxgt-janus's
 * conformance suite ships. `NOT_A_BUILD_INPUT` in `stale.ts` names the same
 * files as sources; a new kind of test file belongs in both.
 */
export const TEST_CODE =
	/(^|\/)__snapshots__\/|\.(spec|test)\.[^/]*$|(^|\/)[^/]+\.fixtures\.[^/]*$/;

/**
 * Test code in the tarball. Every `tsconfig.build.json` excludes `test/` and
 * each `.spec.ts`, and no package holds the other kinds, so the build emits
 * none of it; this holds the day that stops being true. A `.d.ts` for a
 * fixtures file is a published module importing `bun:test`, or a sibling's
 * source that is not in the tarball.
 */
export function testCodeProblems(
	manifest: Record<string, unknown>,
	entries: readonly string[],
): string[] {
	return entries
		.map((path) => path.replace(/^package\//, ''))
		.filter((path) => TEST_CODE.test(path))
		.map((path) => `${manifest.name}: the tarball ships test code: ${path}`);
}
