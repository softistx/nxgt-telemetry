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
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

type Pkg = { name: string; dir: string; subpaths: string[]; bins: string[] };

/** Every subpath a package publishes, from its own `exports` map. */
function subpathsOf(name: string, exports: Record<string, unknown>): string[] {
	return Object.keys(exports)
		.filter((key) => key.startsWith('.') && !key.endsWith('package.json'))
		.map((key) => (key === '.' ? name : `${name}/${key.slice(2)}`));
}

async function readPackages(): Promise<Pkg[]> {
	const dirs = [...new Bun.Glob('packages/*/package.json').scanSync(ROOT)];
	const pkgs: Pkg[] = [];
	for (const rel of dirs.sort()) {
		const manifest = await Bun.file(join(ROOT, rel)).json();
		pkgs.push({
			name: manifest.name,
			dir: join(ROOT, rel.replace(/\/package\.json$/, '')),
			subpaths: subpathsOf(manifest.name, manifest.exports ?? {}),
			bins:
				typeof manifest.bin === 'string'
					? [manifest.name.split('/').pop()]
					: Object.keys(manifest.bin ?? {}),
		});
	}
	return pkgs;
}

/**
 * What a published manifest may not contain, measured on Bun 1.4.0 rather than
 * assumed:
 *
 *   - a `link:` or `file:` in a field a consumer installs. `devDependencies`
 *     are exempt: a consumer never installs a dependency's dev dependencies,
 *     so a `link:` there is untidy, not harmful.
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
 */
async function manifestProblems(tarballs: string[]): Promise<string[]> {
	const problems: string[] = [];
	const own = new Set<string>();
	const manifests: Record<string, unknown>[] = [];

	for (const tgz of tarballs) {
		const raw = await $`tar -xzOf ${tgz} package/package.json`.quiet().text();
		const manifest = JSON.parse(raw);
		manifests.push(manifest);
		own.add(manifest.name);
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

	for (const manifest of manifests) {
		const name = manifest.name as string;

		for (const field of [
			'dependencies',
			'peerDependencies',
			'optionalDependencies',
		]) {
			for (const [dep, range] of Object.entries<string>(
				(manifest[field] as Record<string, string>) ?? {},
			)) {
				if (/^(link|file):/.test(String(range))) {
					problems.push(`${name}: ${field}.${dep} = ${range}`);
				}
				if (own.has(dep) && /^\d/.test(String(range))) {
					problems.push(
						`${name}: ${field}.${dep} = ${range} pins a sibling exactly; ` +
							'use `workspace:^` so the consumer gets one copy',
					);
				}
			}
		}

		const meta =
			(manifest.peerDependenciesMeta as Record<
				string,
				{ optional?: boolean }
			>) ?? {};
		for (const peer of Object.keys(
			(manifest.peerDependencies as Record<string, string>) ?? {},
		)) {
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

	return problems;
}

const packages = await readPackages();
const workdir = await mkdtemp(join(tmpdir(), 'nxgt-telemetry-verify-'));

try {
	console.log(`Packing ${packages.length} packages…`);
	const tarballs: string[] = [];
	const overrides: Record<string, string> = {};
	for (const pkg of packages) {
		await $`bun pm pack --destination ${workdir}`.cwd(pkg.dir).quiet();
		const file = [...new Bun.Glob('*.tgz').scanSync(workdir)]
			.map((f) => join(workdir, f))
			.find((f) => !tarballs.includes(f));
		if (!file) throw new Error(`${pkg.name}: bun pm pack produced no tarball`);
		tarballs.push(file);
		overrides[pkg.name] = `file:${file}`;
	}

	const problems = await manifestProblems(tarballs);
	if (problems.length > 0) {
		console.error('\nA published manifest would break a consumer:\n');
		for (const problem of problems) console.error(`  ${problem}`);
		console.error(
			'\nA `link:` or `file:` no consumer can resolve, a required peer that is\n' +
				'on no registry, an exact pin on a sibling, or a license other than\n' +
				'MIT or no LICENSE shipped. See AGENTS.md.',
		);
		process.exit(1);
	}

	// An optional peer is installed only by whoever asks for it, so ask for each
	// one: the subpath that needs it then loads because it is installed on
	// purpose, not because another package's peer happened to hoist it. One
	// on no registry is left out, as the manifest check above allows.
	const optionalPeers: Record<string, string> = {};
	for (const tgz of tarballs) {
		const manifest = JSON.parse(
			await $`tar -xzOf ${tgz} package/package.json`.quiet().text(),
		);
		const meta: Record<string, { optional?: boolean }> =
			manifest.peerDependenciesMeta ?? {};
		for (const [peer, range] of Object.entries<string>(
			manifest.peerDependencies ?? {},
		)) {
			if (!meta[peer]?.optional || peer in overrides || peer in optionalPeers) {
				continue;
			}
			const res = await fetch(
				`https://registry.npmjs.org/${peer.replace('/', '%2F')}`,
				{ method: 'HEAD' },
			).catch(() => null);
			if (res?.ok) optionalPeers[peer] = range;
		}
	}

	await Bun.write(
		join(workdir, 'package.json'),
		`${JSON.stringify(
			{
				name: 'nxgt-telemetry-artifact-probe',
				private: true,
				version: '0.0.0',
				type: 'module',
				dependencies: { ...optionalPeers, ...overrides },
				overrides,
				resolutions: overrides,
			},
			null,
			2,
		)}\n`,
	);

	console.log('Installing them as a consumer would…');
	const install = await $`bun install`.cwd(workdir).quiet().nothrow();
	if (install.exitCode !== 0) {
		console.error(`\n${install.stderr.toString().trim()}`);
		console.error(
			'\nThe install failed. A required peer on a package that is on no\n' +
				'registry is the usual cause — an optional one never fails an install.',
		);
		process.exit(1);
	}

	const subpaths = packages.flatMap((p) => p.subpaths);
	console.log(`Importing ${subpaths.length} declared subpaths…\n`);
	const probe = subpaths
		.map(
			(s) =>
				`try { const m = await import(${JSON.stringify(s)});` +
				` console.log("  ok      ${s.padEnd(40)}" + Object.keys(m).length + " exports"); }` +
				` catch (e) { failed++; console.log("  FAIL    ${s.padEnd(40)}" + e.message.split("\\n")[0]); }`,
		)
		.join('\n');
	await Bun.write(
		join(workdir, 'probe.mjs'),
		`let failed = 0;\n${probe}\nprocess.exit(failed);\n`,
	);

	const result = await $`bun run probe.mjs`.cwd(workdir).nothrow();
	if (result.exitCode !== 0) {
		console.error(
			`\n${result.exitCode} subpath(s) failed to load from the built artifact.\n` +
				'A build exiting 0 is not evidence the artifact loads. See AGENTS.md.',
		);
		process.exit(1);
	}
	console.log(`\nAll ${subpaths.length} subpaths load.`);

	const bins = packages.flatMap((p) => p.bins);
	if (bins.length > 0) {
		console.log(`\nRunning ${bins.length} declared bin(s) with --help…\n`);
		let broken = 0;
		for (const bin of bins) {
			const ran = await $`./node_modules/.bin/${bin} --help`
				.cwd(workdir)
				.quiet()
				.nothrow();
			const ok = ran.exitCode === 0;
			if (!ok) broken++;
			console.log(
				`  ${ok ? 'ok  ' : 'FAIL'}    ${bin.padEnd(40)}` +
					(ok ? '' : ran.stderr.toString().split('\n')[0]),
			);
		}
		if (broken > 0) {
			console.error(
				`\n${broken} bin(s) failed to run from node_modules/.bin. A missing #!\n` +
					'line or a non-executable file is the usual cause; build.ts checks both.',
			);
			process.exit(1);
		}
		console.log(`\nAll ${bins.length} bin(s) run.`);
	}
} finally {
	await rm(workdir, { recursive: true, force: true });
}
