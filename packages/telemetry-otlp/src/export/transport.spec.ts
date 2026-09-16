import { describe, expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { COMPRESSION_FLOOR, encode, safeUrl } from './transport';

describe('encode', () => {
	test('leaves a small document alone: compressing costs more than it saves', async () => {
		const encoded = await encode('{"a":1}', true);

		expect(encoded.encoded).toBe(false);
		expect(new TextDecoder().decode(encoded.bytes)).toBe('{"a":1}');
	});

	test('gzips a document past the floor, and it decompresses to the same text', async () => {
		const json = JSON.stringify({ a: 'x'.repeat(COMPRESSION_FLOOR) });
		const encoded = await encode(json, true);

		expect(encoded.encoded).toBe(true);
		expect(gunzipSync(encoded.bytes).toString('utf8')).toBe(json);
	});

	/**
	 * The browser story: a bundle that shims `node:zlib` to an empty module
	 * still exports — uncompressed, which every collector accepts — rather than
	 * failing to load.
	 */
	test('falls back to the plain bytes when there is no gzip to call', async () => {
		const json = JSON.stringify({ a: 'x'.repeat(COMPRESSION_FLOOR) });
		const encoded = await encode(json, true, null);

		expect(encoded.encoded).toBe(false);
		expect(new TextDecoder().decode(encoded.bytes)).toBe(json);
	});

	test('a gzip that fails sends the plain bytes rather than nothing', async () => {
		const json = JSON.stringify({ a: 'x'.repeat(COMPRESSION_FLOOR) });
		const failing = ((
			_bytes: unknown,
			callback: (failure: Error | null, result: Buffer) => void,
		) => {
			callback(new Error('no'), Buffer.alloc(0));
		}) as never;

		const encoded = await encode(json, true, failing);

		expect(encoded.encoded).toBe(false);
		expect(new TextDecoder().decode(encoded.bytes)).toBe(json);
	});
});

describe('safeUrl', () => {
	/**
	 * A vendor's collector URL carries its key in the userinfo or the query
	 * string often enough that a failure must not be the thing that writes it
	 * to a log — and a failure is exactly what `onExportError` logs.
	 */
	test('drops the userinfo, keeping the collector and the path', () => {
		expect(safeUrl('https://user:s3cret@otlp.example/v1/logs')).toBe(
			'https://otlp.example/v1/logs',
		);
	});

	test('drops the query string and the fragment', () => {
		expect(safeUrl('https://otlp.example/v1/logs?api-key=s3cret#x')).toBe(
			'https://otlp.example/v1/logs',
		);
	});

	test('leaves an ordinary URL as it is', () => {
		expect(safeUrl('http://localhost:4318/v1/traces')).toBe(
			'http://localhost:4318/v1/traces',
		);
	});

	test('gives back what it was handed when that is not a URL', () => {
		expect(safeUrl('not a url')).toBe('not a url');
	});
});
