#!/usr/bin/env bun
/**
 * Rewrites the workspace to build against the newest version of each peer
 * the packages accept. For a peer range with alternatives, such as
 * `typescript: ^6.0.3 || ^7.0.0`, that is the last one — alternatives are
 * written oldest first. For a single range, such as `mongodb: >=7.0.0 <8`,
 * it is the range itself, which an install without a lockfile resolves to
 * the newest version it allows. A sibling's `workspace:^` is the sibling.
 *
 * The repository's own toolchain is the lockfile's: the exact versions each
 * package pins as a devDependency, the oldest end of each range, so
 * everything CI normally runs proves only that end of it. CI's "Newest peers"
 * job runs this, deletes `bun.lock`, installs, then builds, typechecks, tests
 * and verifies the artifacts: the other end. The ranges come from the
 * packages' own manifests, so widening one is all it takes for this to test
 * it — and a range it could not test fails the run, rather than pass it.
 *
 * Every manifest that installs a rewritten peer gets the same range: the
 * packages' and the examples' `devDependencies` and `dependencies`, and the
 * root's `devDependencies` and `overrides`. One range everywhere is one
 * version in the tree — two `mongodb`s would be two `ObjectId` classes, and
 * two zods two schemas no `instanceof` survives.
 *
 * It edits those manifests in place: run it on a throwaway checkout, never
 * commit what it writes.
 *
 *   bun scripts/newest-peers.ts
 */
import { join } from 'node:path';
import { ROOT } from './artifacts/packages';

export type Manifest = Record<string, unknown> & {
	name?: string;
	peerDependencies?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	overrides?: Record<string, string>;
};

/**
 * The newest end of a range: its last alternative, the range itself when it
 * has one, and `undefined` for a sibling's `workspace:` range.
 */
export function newest(range: string): string | undefined {
	if (range.startsWith('workspace:')) return undefined;
	return range
		.split('||')
		.map((part) => part.trim())
		.at(-1);
}

export interface Rewrite {
	readonly root: Manifest;
	readonly packages: ReadonlyMap<string, Manifest>;
	readonly apps: ReadonlyMap<string, Manifest>;
	/** One line per range set: `<where> <name>@<range>`. */
	readonly pinned: readonly string[];
}

/** The fields of a workspace manifest that install something. */
const INSTALLED = ['dependencies', 'devDependencies'] as const;

/**
 * The manifests with every peer pinned to its newest wherever one installs
 * it: a package's or an example's `dependencies` and `devDependencies`, the
 * root's `devDependencies` and its `overrides`. Pure: the caller writes the
 * result, or nothing when this throws.
 */
export function rewrite(
	root: Manifest,
	packages: ReadonlyMap<string, Manifest>,
	apps: ReadonlyMap<string, Manifest> = new Map(),
): Rewrite {
	const atRoot = new Map<string, string>();
	for (const manifest of packages.values()) {
		for (const [name, range] of Object.entries(
			manifest.peerDependencies ?? {},
		)) {
			const version = newest(range);
			if (version === undefined) continue;
			if (
				manifest.devDependencies?.[name] === undefined &&
				root.devDependencies?.[name] === undefined
			) {
				throw new Error(
					`${manifest.name} accepts ${name} ${range}, but neither it nor the root installs ${name}: add it to ${manifest.name}'s devDependencies.`,
				);
			}
			const seen = atRoot.get(name);
			if (seen !== undefined && seen !== version) {
				throw new Error(
					`The packages disagree on the newest ${name}: ${seen} and ${version}. Align their peer ranges.`,
				);
			}
			atRoot.set(name, version);
		}
	}
	if (atRoot.size === 0) {
		throw new Error('No package has a peer range: nothing newer to test.');
	}

	const pinned: string[] = [];
	const pin = (manifests: ReadonlyMap<string, Manifest>) => {
		const next = new Map<string, Manifest>();
		for (const [path, manifest] of manifests) {
			const copy: Manifest = structuredClone(manifest);
			for (const field of INSTALLED) {
				const deps = copy[field];
				if (deps === undefined) continue;
				for (const [name, version] of atRoot) {
					if (deps[name] === undefined || deps[name] === version) continue;
					deps[name] = version;
					pinned.push(`${String(copy.name).padEnd(28)} ${name}@${version}`);
				}
			}
			next.set(path, copy);
		}
		return next;
	};
	const nextPackages = pin(packages);
	const nextApps = pin(apps);

	const nextRoot: Manifest = structuredClone(root);
	for (const [name, version] of atRoot) {
		const where: string[] = [];
		if (nextRoot.devDependencies?.[name] !== undefined) {
			nextRoot.devDependencies[name] = version;
			where.push('devDependencies');
		}
		if (nextRoot.overrides?.[name] !== undefined) {
			nextRoot.overrides[name] = version;
			where.push('overrides');
		}
		if (where.length > 0) {
			pinned.push(
				`${`(root ${where.join(', ')})`.padEnd(28)} ${name}@${version}`,
			);
		}
	}
	return {
		root: nextRoot,
		packages: nextPackages,
		apps: nextApps,
		pinned,
	};
}

async function write(path: string, manifest: Manifest): Promise<void> {
	await Bun.write(path, `${JSON.stringify(manifest, null, '\t')}\n`);
}

async function manifestsIn(glob: string): Promise<Map<string, Manifest>> {
	const found = new Map<string, Manifest>();
	for (const file of new Bun.Glob(glob).scanSync(ROOT)) {
		const path = join(ROOT, file);
		found.set(path, (await Bun.file(path).json()) as Manifest);
	}
	return found;
}

if (import.meta.main) {
	const rootPath = join(ROOT, 'package.json');
	let result: Rewrite;
	try {
		result = rewrite(
			(await Bun.file(rootPath).json()) as Manifest,
			await manifestsIn('packages/*/package.json'),
			await manifestsIn('examples/*/package.json'),
		);
	} catch (error) {
		console.error((error as Error).message);
		process.exit(1);
	}
	await write(rootPath, result.root);
	for (const [path, manifest] of result.packages) await write(path, manifest);
	for (const [path, manifest] of result.apps) await write(path, manifest);
	for (const line of result.pinned) console.log(`  pinned   ${line}`);
}
