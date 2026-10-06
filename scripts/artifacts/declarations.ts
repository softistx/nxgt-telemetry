/** Marks a string literal's place in the code: its index in `strings`. */
const MARK = '\u0001';
const LITERAL = `${MARK}(\\d+)${MARK}`;
/** A masked string that is not the specifier, such as a quoted export name. */
const ANY_LITERAL = `${MARK}\\d+${MARK}`;

/** Every form a declaration file names a module in, its specifier a literal. */
const FORMS = [
	// import … from 'x', import type … from 'x', export … from 'x', export * from
	// 'x', and export { "a-b" as ab } from 'x', a string before `from`
	new RegExp(
		`\\b(?:import|export)\\b(?:[^;${MARK}]|${ANY_LITERAL})*?\\bfrom\\s*${LITERAL}`,
		'g',
	),
	// import 'x'
	new RegExp(`\\bimport\\s*${LITERAL}`, 'g'),
	// import('x').T, and import('x', { with: { 'resolution-mode': 'import' } }).T
	new RegExp(`\\bimport\\s*\\(\\s*${LITERAL}\\s*[,)]`, 'g'),
	// import x = require('x'), import type x = require('x')
	new RegExp(
		`\\bimport\\s+(?:type\\s+)?[\\w$]+\\s*=\\s*require\\s*\\(\\s*${LITERAL}\\s*\\)`,
		'g',
	),
];

/**
 * `declare module 'x' { … }`: in a module, an augmentation of `x`, which a
 * consumer's tsc must resolve; in a script, an ambient module it declares.
 */
const AUGMENTATION = new RegExp(`\\bdeclare\\s+module\\s*${LITERAL}`, 'g');

/**
 * Whether top-level code makes a module, as `ts.preProcessFile` decides:
 * an import, an export, or a type's `import('x')` outside any block.
 */
const MODULE = /(?:^|[;}\s=<(|&,])(?:import|export)\b/;

/** `/// <reference types="x" />`, whatever attribute comes first. */
const REFERENCE_TYPES =
	/^\/\/\/\s*<reference\s[^>]*?\btypes\s*=\s*(["'])([^"']+)\1/;

/** A line terminator, which a backslash before it turns into nothing. */
const LINE_BREAKS = new Set(['\n', '\r', '\u2028', '\u2029']);

const ESCAPES: Readonly<Record<string, string>> = {
	n: '\n',
	r: '\r',
	t: '\t',
	b: '\b',
	f: '\f',
	v: '\v',
	'0': '\0',
};

/**
 * Reads a declaration file's code: comments removed, each string literal
 * replaced by a mark, and a template literal's `${…}` read as code, so that
 * neither a JSDoc example nor a string literal type can pass for an import.
 */
class Scanner {
	readonly strings: string[] = [];
	readonly references: string[] = [];
	#i = 0;
	/** The code outside every `{ … }` block, to tell a module from a script. */
	topLevel = '';
	/** Code came: from here on a triple-slash line is a comment, as for tsc. */
	#codeSeen = false;

	constructor(readonly text: string) {
		// A leading `#!` line is no code: the references after it still lead.
		if (text.startsWith('#!')) {
			const end = text.indexOf('\n');
			this.#i = end < 0 ? text.length : end;
		}
	}

	/** The code to the end of the text, or to the `}` that closes a template's `${`. */
	code(inSubstitution = false): string {
		const { text } = this;
		let code = '';
		let depth = 0;
		while (this.#i < text.length) {
			const char = text[this.#i] as string;
			const next = text[this.#i + 1];
			if (char === '/' && next === '/') {
				this.#lineComment(inSubstitution);
			} else if (char === '/' && next === '*') {
				const end = text.indexOf('*/', this.#i + 2);
				this.#i = end < 0 ? text.length : end + 2;
				code += ' ';
			} else if (char === '"' || char === "'") {
				this.#codeSeen = true;
				code += this.#mark(this.#string(char));
			} else if (char === '`') {
				this.#codeSeen = true;
				code += this.#template();
			} else if (inSubstitution && char === '}' && depth === 0) {
				this.#i++;
				return code;
			} else {
				if (char === '}') depth--;
				if (!inSubstitution && depth === 0) this.topLevel += char;
				if (char === '{') depth++;
				if (!/\s/.test(char)) this.#codeSeen = true;
				code += char;
				this.#i++;
			}
		}
		return code;
	}

	/**
	 * Skips a line comment, keeping a `/// <reference types>` among the
	 * leading comments: tsc reads none once code has begun.
	 */
	#lineComment(inSubstitution: boolean): void {
		const end = this.text.indexOf('\n', this.#i);
		const stop = end < 0 ? this.text.length : end;
		if (!this.#codeSeen && !inSubstitution) {
			const reference = REFERENCE_TYPES.exec(this.text.slice(this.#i, stop));
			if (reference) this.references.push(reference[2] as string);
		}
		this.#i = stop;
	}

	#mark(value: string): string {
		return `${MARK}${this.strings.push(value) - 1}${MARK}`;
	}

	/** A quoted string, from its opening quote, its escapes decoded. */
	#string(quote: string): string {
		const { text } = this;
		let value = '';
		this.#i++;
		while (this.#i < text.length && text[this.#i] !== quote) {
			if (text[this.#i] === '\\') {
				value += this.#escape();
			} else {
				value += text[this.#i];
				this.#i++;
			}
		}
		this.#i++;
		return value;
	}

	/** A template literal: each text part masked, each `${…}` read as code. */
	#template(): string {
		const { text } = this;
		let code = '';
		let part = '';
		this.#i++;
		while (this.#i < text.length && text[this.#i] !== '`') {
			if (text[this.#i] === '\\') {
				part += this.#escape();
			} else if (text[this.#i] === '$' && text[this.#i + 1] === '{') {
				this.#i += 2;
				code += `${this.#mark(part)} ${this.code(true)} `;
				part = '';
			} else {
				part += text[this.#i];
				this.#i++;
			}
		}
		this.#i++;
		return `${code}${this.#mark(part)}`;
	}

	/**
	 * One escape, from its backslash, as JavaScript reads it: `\n`, `\x41`,
	 * `\u0041`, `\u{1F600}`, a legacy octal `\101`, a line continuation
	 * (nothing), or the character itself. A `\u{` left open stops at the
	 * string's end and stands for `u`, so it never swallows what follows.
	 */
	#escape(): string {
		const { text } = this;
		const char = text[this.#i + 1] ?? '';
		const hex = (from: number, length: number) =>
			String.fromCodePoint(
				Number.parseInt(text.slice(from, from + length), 16) || 0,
			);
		if (LINE_BREAKS.has(char)) {
			this.#i += char === '\r' && text[this.#i + 2] === '\n' ? 3 : 2;
			return '';
		}
		const octal = /^[0-3][0-7]{0,2}|^[4-7][0-7]?/.exec(
			text.slice(this.#i + 1, this.#i + 4),
		);
		if (octal && !(octal[0] === '0' && /[89]/.test(text[this.#i + 2] ?? ''))) {
			this.#i += 1 + octal[0].length;
			return String.fromCharCode(Number.parseInt(octal[0], 8));
		}
		if (char === 'x') {
			this.#i += 4;
			return hex(this.#i - 2, 2);
		}
		if (char === 'u' && text[this.#i + 2] === '{') {
			const close = /[}'"`\n]/.exec(text.slice(this.#i + 3));
			const end = close ? this.#i + 3 + close.index : text.length;
			if (text[end] !== '}') {
				this.#i += 2;
				return 'u';
			}
			const value = hex(this.#i + 3, end - this.#i - 3);
			this.#i = end + 1;
			return value;
		}
		if (char === 'u') {
			this.#i += 6;
			return hex(this.#i - 4, 4);
		}
		this.#i += 2;
		return ESCAPES[char] ?? char;
	}
}

/**
 * The modules a `.d.ts` names, read without TypeScript's own API, which
 * TypeScript 7 no longer exports: every `import` and `export … from`
 * (type-only included), `import('x')` in a type (inside a template literal
 * type too), `import x = require('x')`, `declare module 'x'` in a module
 * (an augmentation), and `/// <reference types="x" />` among the leading
 * comments — what `ts.preProcessFile` reports. Comments and string literals
 * cannot pass for an import, and string escapes are decoded as JavaScript
 * does. Built for what tsc emits; a specifier that is not a literal is out
 * of its reach.
 */
export function declarationSpecifiers(text: string): string[] {
	const scanner = new Scanner(text);
	const code = scanner.code();
	const found = [...scanner.references];
	const forms = MODULE.test(scanner.topLevel)
		? [...FORMS, AUGMENTATION]
		: FORMS;
	for (const form of forms) {
		for (const match of code.matchAll(form)) {
			found.push(scanner.strings[Number(match[1])] as string);
		}
	}
	return found;
}
