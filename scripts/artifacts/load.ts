import { join } from 'node:path';
import { $ } from 'bun';
import type { Pkg } from './packages';

/** Imports every declared subpath from the install; false if one fails. */
export async function subpathsLoad(
	workdir: string,
	packages: readonly Pkg[],
): Promise<boolean> {
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
		return false;
	}
	console.log(`\nAll ${subpaths.length} subpaths load.`);
	return true;
}

/**
 * Runs every declared bin from `node_modules/.bin` with `--help`, which proves
 * the link, the `#!` line and the mode together; false if one fails.
 */
export async function binsRun(
	workdir: string,
	packages: readonly Pkg[],
): Promise<boolean> {
	const bins = packages.flatMap((p) => p.bins);
	if (bins.length === 0) return true;
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
		return false;
	}
	console.log(`\nAll ${bins.length} bin(s) run.`);
	return true;
}
