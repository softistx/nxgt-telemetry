import { join } from 'node:path';

/** The repository root, whatever the working directory. */
export const ROOT = new URL('../..', import.meta.url).pathname.replace(
	/\/$/,
	'',
);

export type Pkg = {
	name: string;
	dir: string;
	version: string;
	subpaths: string[];
	bins: string[];
};

/** Every subpath a package publishes, from its own `exports` map. */
export function subpathsOf(
	name: string,
	exports: Record<string, unknown>,
): string[] {
	return Object.keys(exports)
		.filter((key) => key.startsWith('.') && !key.endsWith('package.json'))
		.map((key) => (key === '.' ? name : `${name}/${key.slice(2)}`));
}

/**
 * Every package under `packages/`, private or not: a private package is still
 * packed and loaded, so the checks run on it from its first commit.
 */
export async function readPackages(): Promise<Pkg[]> {
	const dirs = [...new Bun.Glob('packages/*/package.json').scanSync(ROOT)];
	const pkgs: Pkg[] = [];
	for (const rel of dirs.sort()) {
		const manifest = await Bun.file(join(ROOT, rel)).json();
		pkgs.push({
			name: manifest.name,
			dir: join(ROOT, rel.replace(/\/package\.json$/, '')),
			version: manifest.version,
			subpaths: subpathsOf(manifest.name, manifest.exports ?? {}),
			bins:
				typeof manifest.bin === 'string'
					? [manifest.name.split('/').pop()]
					: Object.keys(manifest.bin ?? {}),
		});
	}
	return pkgs;
}
