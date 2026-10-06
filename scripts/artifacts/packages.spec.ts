import { describe, expect, test } from 'bun:test';
import { subpathsOf } from './packages';

describe('subpathsOf', () => {
	test('names every exported subpath, and not package.json', () => {
		expect(
			subpathsOf('@nxgt/mongo', {
				'.': {},
				'./gridfs': {},
				'./migrations': {},
				'./package.json': './package.json',
			}),
		).toEqual(['@nxgt/mongo', '@nxgt/mongo/gridfs', '@nxgt/mongo/migrations']);
	});
});
