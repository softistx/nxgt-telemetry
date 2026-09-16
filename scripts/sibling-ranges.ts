/**
 * Whether each packed package asks for **exactly** the sibling version being
 * published beside it.
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
 * The comparison is exact rather than "does the sibling satisfy the range",
 * for two reasons measured on Bun 1.4.2:
 *
 *   - a stale lock *within* one minor — lock 0.2.0, manifest 0.2.1 — packs
 *     `^0.2.0`, which 0.2.1 satisfies, while the package may use an API that
 *     only 0.2.1 has;
 *   - `Bun.semver.satisfies` answers `true` for a range that is not a range at
 *     all: `'garbage!!'`, `'latest'`, `''`.
 *
 * `verify:artifacts` installs the tarballs with `overrides` pointing each
 * sibling at its own tarball, which is right for what it tests and is exactly
 * why the install alone could not see this.
 */
export interface PackedManifest {
	readonly name: string;
	readonly version: string;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
}

/** The fields a consumer's install resolves. */
export const INSTALLED_FIELDS = [
	'dependencies',
	'peerDependencies',
	'optionalDependencies',
] as const;

/**
 * What `bun pm pack` must turn a `workspace:` spec into, given the sibling's
 * version. Anything that is not a `workspace:` spec is not this check's.
 */
export function expectedRange(
	spec: string,
	version: string,
): string | undefined {
	switch (spec) {
		case 'workspace:^':
			return `^${version}`;
		case 'workspace:~':
			return `~${version}`;
		case 'workspace:*':
			return version;
		default:
			return spec.startsWith('workspace:')
				? spec.slice('workspace:'.length)
				: undefined;
	}
}

/**
 * @param packed the manifests as they are in the tarballs
 * @param sources the same packages' manifests as they are in the repository,
 *   which is where the `workspace:` specs still are
 */
export function siblingRangeProblems(
	packed: readonly PackedManifest[],
	sources: readonly PackedManifest[],
): string[] {
	const versions = new Map(packed.map((m) => [m.name, m.version]));
	const source = new Map(sources.map((m) => [m.name, m]));
	const problems: string[] = [];

	for (const manifest of packed) {
		for (const field of INSTALLED_FIELDS) {
			const specs = source.get(manifest.name)?.[field] ?? {};

			for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
				const version = versions.get(dep);
				const spec = specs[dep];
				if (version === undefined || spec === undefined) continue;

				const expected = expectedRange(spec, version);
				if (expected === undefined || range === expected) continue;

				problems.push(
					`${manifest.name}: ${field}.${dep} = ${range}, but ${spec} with ` +
						`${dep}@${version} beside it should pack as ${expected}. ` +
						'bun.lock is probably stale: run `bun install` after ' +
						'`changeset version`.',
				);
			}
		}
	}

	return problems;
}
