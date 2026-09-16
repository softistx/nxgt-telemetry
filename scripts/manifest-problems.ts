import { $ } from 'bun';
import {
	INSTALLED_FIELDS,
	type PackedManifest,
	siblingRangeProblems,
} from './sibling-ranges';

type Manifest = PackedManifest & {
	readonly license?: string;
	readonly peerDependenciesMeta?: Readonly<
		Record<string, { optional?: boolean }>
	>;
};

/**
 * What a published manifest may not contain, measured on Bun 1.4.0 rather than
 * assumed:
 *
 *   - a `link:`, `file:` or `workspace:` in a field a consumer installs.
 *     `devDependencies` are exempt: a consumer never installs a dependency's
 *     dev dependencies, so a `link:` there is untidy, not harmful. A
 *     `workspace:` left in a tarball means `bun pm pack` did not resolve it.
 *   - a **required** peer that is on no registry. This is the shape that once
 *     broke every consumer's install of nxgt-core with a 404. An *optional*
 *     peer is safe whatever its range; a required one is not.
 *   - an **exact pin on a sibling package**. `workspace:*` publishes as the
 *     exact version, so a package would demand the exact
 *     sibling it was built with while the consumer's own caret range
 *     resolved to a newer one: two copies in one tree, and two
 *     `ValidationError` classes. `workspace:^` publishes
 *     as a caret range, which dedupes.
 *   - a **license other than MIT, or no `LICENSE` in the tarball**. npm only
 *     ships the `LICENSE` in the package's own directory, never the root's.
 *   - a **sibling range other than the one its `workspace:` spec asks for** —
 *     see `sibling-ranges.ts`. The install's `overrides` would otherwise hide
 *     it.
 *
 * @param tarballs the packed packages
 * @param sources the same packages' manifests from the repository
 */
export async function manifestProblems(
	tarballs: readonly string[],
	sources: readonly PackedManifest[],
): Promise<string[]> {
	const problems: string[] = [];
	const manifests: Manifest[] = [];

	for (const tgz of tarballs) {
		const raw = await $`tar -xzOf ${tgz} package/package.json`.quiet().text();
		const manifest: Manifest = JSON.parse(raw);
		manifests.push(manifest);
		if (manifest.license !== 'MIT') {
			problems.push(
				`${manifest.name}: license is ${manifest.license}, not MIT`,
			);
		}
		const entries = (await $`tar -tzf ${tgz}`.quiet().text()).split('\n');
		if (!entries.includes('package/LICENSE')) {
			problems.push(`${manifest.name}: the tarball has no LICENSE`);
		}
	}

	const own = new Set(manifests.map((m) => m.name));

	for (const manifest of manifests) {
		const { name } = manifest;

		for (const field of INSTALLED_FIELDS) {
			for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
				if (/^(link|file|workspace):/.test(range)) {
					problems.push(`${name}: ${field}.${dep} = ${range}`);
				}
				if (own.has(dep) && /^\d/.test(range)) {
					problems.push(
						`${name}: ${field}.${dep} = ${range} pins a sibling exactly; ` +
							'use `workspace:^` so the consumer gets one copy',
					);
				}
			}
		}

		const meta = manifest.peerDependenciesMeta ?? {};
		for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
			if (meta[peer]?.optional || own.has(peer)) continue;
			const res = await fetch(
				`https://registry.npmjs.org/${peer.replace('/', '%2F')}`,
				{ method: 'HEAD' },
			).catch(() => null);
			if (!res?.ok) {
				problems.push(
					`${name}: peerDependencies.${peer} is required but is on no registry`,
				);
			}
		}
	}

	problems.push(...siblingRangeProblems(manifests, sources));

	return problems;
}
