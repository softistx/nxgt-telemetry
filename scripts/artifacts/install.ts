import { join } from 'node:path';
import { $ } from 'bun';
import type { Pkg } from './packages';
import { onRegistry } from './registry';
import { readTarball, type Tarball } from './tarball';

export type Packed = {
	tarballs: Tarball[];
	/** Each package's name to `file:<its tarball>`. */
	overrides: Record<string, string>;
};

/** Packs every package into `workdir`, the way `npm publish` would. */
export async function pack(
	workdir: string,
	packages: readonly Pkg[],
): Promise<Packed> {
	console.log(`Packing ${packages.length} packages…`);
	const files: string[] = [];
	const overrides: Record<string, string> = {};
	for (const pkg of packages) {
		await $`bun pm pack --destination ${workdir}`.cwd(pkg.dir).quiet();
		const file = [...new Bun.Glob('*.tgz').scanSync(workdir)]
			.map((f) => join(workdir, f))
			.find((f) => !files.includes(f));
		if (!file) throw new Error(`${pkg.name}: bun pm pack produced no tarball`);
		files.push(file);
		overrides[pkg.name] = `file:${file}`;
	}
	return { tarballs: await Promise.all(files.map(readTarball)), overrides };
}

/**
 * An optional peer is installed only by whoever asks for it, so ask for each
 * one: the subpath that needs it then loads because it is installed on
 * purpose, not because another package's peer happened to hoist it. One on no
 * registry is left out, as the manifest check allows.
 */
async function optionalPeersOf({
	tarballs,
	overrides,
}: Packed): Promise<Record<string, string>> {
	const peers: Record<string, string> = {};
	for (const { manifest } of tarballs) {
		const meta =
			(manifest.peerDependenciesMeta as Record<
				string,
				{ optional?: boolean }
			>) ?? {};
		for (const [peer, range] of Object.entries<string>(
			(manifest.peerDependencies as Record<string, string>) ?? {},
		)) {
			if (!meta[peer]?.optional || peer in overrides || peer in peers) {
				continue;
			}
			if (await onRegistry(peer)) peers[peer] = range;
		}
	}
	return peers;
}

/**
 * Installs the tarballs in `workdir` as a consumer would; false if the install
 * fails. `overrides` makes the packages resolve to each other's tarballs, not
 * to the registry's published versions.
 */
export async function installAsConsumer(
	workdir: string,
	packed: Packed,
): Promise<boolean> {
	const { overrides } = packed;
	const probe = {
		name: 'nxgt-data-artifact-probe',
		private: true,
		version: '0.0.0',
		type: 'module',
		dependencies: { ...(await optionalPeersOf(packed)), ...overrides },
		overrides,
		resolutions: overrides,
	};
	await Bun.write(
		join(workdir, 'package.json'),
		`${JSON.stringify(probe, null, 2)}\n`,
	);

	console.log('Installing them as a consumer would…');
	const install = await $`bun install`.cwd(workdir).quiet().nothrow();
	if (install.exitCode === 0) return true;
	console.error(`\n${install.stderr.toString().trim()}`);
	console.error(
		'\nThe install failed. A required peer on a package that is on no\n' +
			'registry is the usual cause — an optional one never fails an install.',
	);
	return false;
}
