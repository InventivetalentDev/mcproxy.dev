import { describe, it, expect } from 'vitest';
import { decodeTextures, isValidName, isValidUuid, normalizeName, normalizeUuid, wantsFresh } from '../src/util';

describe('uuid validation', () => {
	it('accepts both spellings, in either case', () => {
		expect(isValidUuid('45f50155c09f4fdcb5cee30af2ebd1f0')).toBe(true);
		expect(isValidUuid('45f50155-c09f-4fdc-b5ce-e30af2ebd1f0')).toBe(true);
		// The old pattern had no `i` flag, so an uppercase UUID was rejected outright.
		expect(isValidUuid('45F50155C09F4FDCB5CEE30AF2EBD1F0')).toBe(true);
	});

	it('rejects strings that are only the right length', () => {
		// The old pattern was [a-f0-9-]{32,36}, which this passed — and it normalised to an empty
		// key, so every such request collided on one cache entry.
		expect(isValidUuid('-'.repeat(36))).toBe(false);
		expect(isValidUuid('45f50155-c09f-4fdc-b5ce-e30af2ebd1f')).toBe(false);
		expect(isValidUuid('g'.repeat(32))).toBe(false);
	});

	it('collapses every spelling onto one key', () => {
		const expected = '45f50155c09f4fdcb5cee30af2ebd1f0';
		expect(normalizeUuid('45f50155-c09f-4fdc-b5ce-e30af2ebd1f0')).toBe(expected);
		expect(normalizeUuid('45F50155C09F4FDCB5CEE30AF2EBD1F0')).toBe(expected);
	});
});

describe('name validation', () => {
	it('accepts real names and rejects the rest', () => {
		expect(isValidName('inventivetalent')).toBe(true);
		expect(isValidName('a_1')).toBe(true);
		expect(isValidName('seventeen_chars_x')).toBe(false);
		expect(isValidName('has space')).toBe(false);
		expect(isValidName('')).toBe(false);
	});

	it('collapses casings onto one key', () => {
		expect(normalizeName('InventiveTalent')).toBe('inventivetalent');
	});
});

describe('freshness requests', () => {
	it('recognises no-cache and no-store', () => {
		expect(wantsFresh(new Headers({ 'cache-control': 'no-cache' }))).toBe(true);
		expect(wantsFresh(new Headers({ 'cache-control': 'public, no-store' }))).toBe(true);
	});

	it('is not fooled by a directive that merely contains one', () => {
		expect(wantsFresh(new Headers({ 'cache-control': 'max-age=0' }))).toBe(false);
		expect(wantsFresh(new Headers())).toBe(false);
	});
});

describe('texture decoding', () => {
	const encode = (textures: object) => btoa(JSON.stringify({ textures }));

	it('pulls skin, cape and arm model out of the textures property', () => {
		const value = encode({
			SKIN: { url: 'http://textures.minecraft.net/texture/abc', metadata: { model: 'slim' } },
			CAPE: { url: 'http://textures.minecraft.net/texture/def' }
		});
		expect(decodeTextures([{ name: 'textures', value }])).toEqual({
			skin: 'https://textures.minecraft.net/texture/abc',
			slim: true,
			cape: 'https://textures.minecraft.net/texture/def'
		});
	});

	it('treats a missing cape as absent, not as an error', () => {
		const value = encode({ SKIN: { url: 'http://textures.minecraft.net/texture/abc' } });
		expect(decodeTextures([{ name: 'textures', value }])).toEqual({
			skin: 'https://textures.minecraft.net/texture/abc',
			slim: false
		});
	});

	it('refuses to proxy anything that is not on the texture host', () => {
		const value = encode({ SKIN: { url: 'https://example.com/evil.png' } });
		expect(decodeTextures([{ name: 'textures', value }])).toEqual({});
	});

	it('survives a profile with no or garbage properties', () => {
		expect(decodeTextures(undefined)).toEqual({});
		expect(decodeTextures([])).toEqual({});
		expect(decodeTextures([{ name: 'textures', value: 'not base64 json' }])).toEqual({});
	});
});
