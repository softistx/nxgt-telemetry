import { packageOf } from './imports';

/** A JavaScript file and the declaration file tsc looks for beside it. */
const BESIDE: readonly (readonly [js: string, dts: string])[] = [
	['.js', '.d.ts'],
	['.mjs', '.d.mts'],
	['.cjs', '.d.cts'],
];

/** What tsc takes as a target as it is: a declaration file or a TypeScript source. */
const DECLARATION = /\.(d\.)?[mc]?tsx?$/;

/**
 * The conditions tsc matches for an import from an ESM declaration file
 * under `bundler`, Bun's resolution: `import`, `types` and `default`, plus
 * `types@<range>`, taken whatever its range. Not `node`, which only
 * `node16` and `nodenext` add, nor `require`, `browser` or a custom one.
 */
const CONDITIONS = new Set(['import', 'types', 'default']);

/** An installed package: its manifest, and whether its folder holds a file. */
export type Installed = {
	manifest: Record<string, unknown>;
	has: (rel: string) => boolean;
};

/** The subpath `exports` keys a specifier under: `.`, or `./<rest>`. */
export function subpathOf(specifier: string): string {
	const rest = specifier.slice(packageOf(specifier).length);
	return rest === '' ? '.' : `.${rest}`;
}

/**
 * Whether a path leads tsc to types: the file itself when it is a
 * declaration file or a TypeScript source, a declaration file beside a
 * `.js`, `.mjs` or `.cjs`, or, extensionless, `<path>.d.ts` or
 * `<path>/index.d.ts`.
 */
function declares(path: unknown, has: Installed['has']): boolean {
	if (typeof path !== 'string') return false;
	if (DECLARATION.test(path)) return has(path);
	const js = BESIDE.find(([ext]) => path.endsWith(ext));
	if (js) return has(path.slice(0, -js[0].length) + js[1]);
	return has(`${path}.d.ts`) || has(`${path.replace(/\/$/, '')}/index.d.ts`);
}

/**
 * Whether an `exports` entry, its `*` already replaced, names types, read
 * as tsc does: in order, only the `CONDITIONS` it matches, recursing into a
 * value that is conditions itself (`types` included), going on past one
 * that does not resolve and stopping at a matched `null`. A string target
 * must `declares`; one still holding a `*` is taken as it is.
 */
function entryTypes(value: unknown, has: Installed['has']): boolean {
	if (typeof value === 'string') {
		return value.includes('*') || declares(value, has);
	}
	if (Array.isArray(value)) return value.some((each) => entryTypes(each, has));
	if (value === null || typeof value !== 'object') return false;
	for (const [key, each] of Object.entries(value as Record<string, unknown>)) {
		if (!CONDITIONS.has(key) && !key.startsWith('types@')) continue;
		if (each === null) return false;
		if (entryTypes(each, has)) return true;
	}
	return false;
}

/** Replaces every `*` in an entry's strings with what the pattern matched. */
function substitute(value: unknown, star: string): unknown {
	if (typeof value === 'string') return value.replaceAll('*', star);
	if (Array.isArray(value)) return value.map((each) => substitute(each, star));
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, each]) => [
			key,
			substitute(each, star),
		]),
	);
}

/** Whether `exports` is the entry of `.` itself: a string, an array, or conditions. */
function onlyDot(exports: unknown): boolean {
	return (
		typeof exports === 'string' ||
		Array.isArray(exports) ||
		(typeof exports === 'object' &&
			exports !== null &&
			!Object.keys(exports).some((key) => key.startsWith('.')))
	);
}

/**
 * The `exports` entry a subpath resolves to: the exact key first, then the
 * `*` pattern with the longest prefix, the longer key at a tie, as tsc's
 * `comparePatternKeys`. Conditions or a string at the top are the entry of
 * `.` alone. Undefined when `exports` does not export it. A folder key
 * (`"./"`), deprecated by Node, is not read: no subpath matches it.
 */
function exportsEntry(exports: unknown, subpath: string): unknown {
	if (onlyDot(exports)) return subpath === '.' ? exports : undefined;
	const map = exports as Record<string, unknown>;
	if (Object.hasOwn(map, subpath)) return map[subpath];
	let best: [prefix: string, suffix: string, key: string] | undefined;
	for (const key of Object.keys(map)) {
		const [prefix = '', suffix = '', ...more] = key.split('*');
		if (!key.includes('*') || more.length > 0) continue;
		if (
			subpath.startsWith(prefix) &&
			subpath.endsWith(suffix) &&
			subpath.length >= prefix.length + suffix.length &&
			(!best ||
				prefix.length > best[0].length ||
				(prefix.length === best[0].length && key.length > best[2].length))
		) {
			best = [prefix, suffix, key];
		}
	}
	if (!best) return undefined;
	const [prefix, suffix, key] = best;
	return substitute(
		map[key],
		subpath.slice(prefix.length, subpath.length - suffix.length),
	);
}

/**
 * Whether a package ships declarations for one subpath of it, close to
 * how tsc under `bundler` resolution finds them, not tsc itself. With
 * `exports`, only the subpath's entry counts, read by `entryTypes` (yargs
 * 18 types `./browser` alone, so `yargs` itself is untyped). Without, for
 * `.` a `types` or `typings` field, `main` or an `index.d.ts`, and for any
 * other subpath the file it names, extensionless paths read as tsc does.
 * A `typesVersions` without `exports` counts as typed without being
 * resolved: its ranges match the consumer's TypeScript, which this cannot
 * know.
 */
export function shipsTypes(
	{ manifest, has }: Installed,
	subpath = '.',
): boolean {
	const exports = manifest['exports'];
	if (exports !== undefined && exports !== null) {
		return entryTypes(exportsEntry(exports, subpath), has);
	}
	if (manifest['typesVersions'] !== undefined) return true;
	if (subpath !== '.') return declares(subpath, has);
	return (
		declares(manifest['types'], has) ||
		declares(manifest['typings'], has) ||
		declares(manifest['main'], has) ||
		has('index.d.ts')
	);
}
