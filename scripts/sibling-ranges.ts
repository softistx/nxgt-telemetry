/**
 * Whether each packed package asks for a version of its siblings that the
 * siblings being published actually are.
 *
 * `bun pm pack` turns `workspace:^` into a caret range, and it takes the
 * version **from `bun.lock`**, not from the sibling's `package.json`. After
 * `changeset version` bumps the manifests, the lockfile still names the old
 * versions until something runs `bun install` — and `bun install
 * --frozen-lockfile` does not notice. So the 0.2.0 release of every
 * integration shipped asking for `@nxgt/telemetry@^0.1.0`, which in 0.x
 * excludes 0.2.0: a consumer got the 0.1.0 core underneath the 0.2.0
 * integrations.
 *
 * `verify:artifacts` installs the tarballs with `overrides` pointing each
 * sibling at its own tarball, which is right for what it tests and is exactly
 * why it could not see this. This check reads the ranges instead.
 */
export interface PackedManifest {
	readonly name: string;
	readonly version: string;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
}

const FIELDS = [
	'dependencies',
	'peerDependencies',
	'optionalDependencies',
] as const;

export function siblingRangeProblems(
	manifests: readonly PackedManifest[],
): string[] {
	const versions = new Map(manifests.map((m) => [m.name, m.version]));
	const problems: string[] = [];

	for (const manifest of manifests) {
		for (const field of FIELDS) {
			for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
				const version = versions.get(dep);
				if (version === undefined) continue;
				// A `workspace:` or `link:` left unresolved is reported
				// elsewhere; this is only about ranges a registry would read.
				if (/^[a-z]+:/.test(range)) continue;
				if (Bun.semver.satisfies(version, range)) continue;

				problems.push(
					`${manifest.name}: ${field}.${dep} = ${range} does not accept ` +
						`${dep}@${version}, the version being published beside it. ` +
						'bun.lock is probably stale: run `bun install` after ' +
						'`changeset version`.',
				);
			}
		}
	}

	return problems;
}
