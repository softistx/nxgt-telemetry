#!/usr/bin/env bun

/**
 * Packs every package, installs the tarballs the way a consumer does, and
 * imports every subpath each one declares.
 *
 * This exists because `bun run build` exiting 0 proves almost nothing here.
 * The specs import each sibling's source, so nothing they run loads `dist/`.
 * In nxgt-core, where this script comes from, three defects shipped past a
 * green build, each throwing the instant its package was imported, and all
 * three invisible to `bun run build`, `bun typecheck` and `biome`.
 * Only importing the built artifact catches that class of failure. A bin is
 * the same story, so each one declared is run from `node_modules/.bin` with
 * `--help`: that proves the link, the `#!` line and the mode together.
 *
 * The install uses `overrides` so the packages resolve to each other's
 * tarballs rather than to whatever is on the registry — otherwise this would
 * silently verify the *published* versions instead of the working tree.
 * Everything else resolves from the registry the way a consumer's install
 * does. Optional peers are installed too, the way a
 * consumer who uses the subpath that needs one would.
 *
 * A package's `test/declarations/*.ts` is compiled with the declaration
 * build on, against the install: a type a consumer's `.d.ts` must name and
 * the entry does not export fails there with TS2883, and nowhere else.
 *
 * Every built import must name something the manifest declares: the
 * install holds every sibling, so an undeclared one would load here and
 * fail for a consumer.
 *
 * Each check lives in `scripts/artifacts/`, one module per responsibility;
 * this file only runs them in order and stops at the first that fails.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classesDefinedOnce } from './artifacts/classes';
import { declarationsEmit } from './artifacts/emit';
import { importsDeclared } from './artifacts/imports';
import { installAsConsumer, type Packed, pack } from './artifacts/install';
import { binsRun, subpathsLoad } from './artifacts/load';
import { manifestProblems } from './artifacts/manifest';
import { type Pkg, readPackages } from './artifacts/packages';
import { staleBuilds } from './artifacts/stale';

async function builtFresh(packages: readonly Pkg[]): Promise<boolean> {
	const stale = await staleBuilds([...packages]);
	if (stale.length === 0) return true;
	console.error('This would verify a stale build, not the working tree:\n');
	for (const one of stale) console.error(`  ${one}`);
	console.error(
		'\nRun `bun run build` first. This script packs `dist/`, which is\n' +
			'gitignored, so a stale one reports failures the source does not have —\n' +
			'and they look like environment problems, not build problems.',
	);
	return false;
}

async function tarballsSound(
	packages: readonly Pkg[],
	{ tarballs }: Packed,
): Promise<boolean> {
	const sources = await Promise.all(
		packages.map((p) => Bun.file(join(p.dir, 'package.json')).json()),
	);
	const problems = await manifestProblems(tarballs, sources);
	if (problems.length === 0) return true;
	console.error('\nA published tarball would break a consumer:\n');
	for (const problem of problems) console.error(`  ${problem}`);
	console.error(
		'\nA `link:`, `file:` or `workspace:` no consumer can resolve, a required\n' +
			'peer that is on no registry, a sibling range other than the one its\n' +
			'`workspace:` spec produces, an exact pin on a sibling, a package that\n' +
			'lists itself, a license other than MIT or no LICENSE shipped, a\n' +
			'`files` entry the tarball does not hold, test code shipped, or a\n' +
			'scoped package not published as public. See AGENTS.md.',
	);
	return false;
}

async function main(): Promise<boolean> {
	const packages = await readPackages();
	if (!(await builtFresh(packages))) return false;

	const workdir = await mkdtemp(join(tmpdir(), 'nxgt-telemetry-verify-'));
	try {
		const packed = await pack(workdir, packages);
		return (
			(await tarballsSound(packages, packed)) &&
			(await installAsConsumer(workdir, packed)) &&
			(await subpathsLoad(workdir, packages)) &&
			(await classesDefinedOnce(workdir, packages)) &&
			(await importsDeclared(workdir, packages)) &&
			(await binsRun(workdir, packages)) &&
			(await declarationsEmit(workdir, packages))
		);
	} finally {
		await rm(workdir, { recursive: true, force: true });
	}
}

if (import.meta.main && !(await main())) {
	process.exit(1);
}
