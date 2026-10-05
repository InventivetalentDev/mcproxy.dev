import { cached } from './cache';
import { CacheConfig } from './config';
import { CacheStore } from './store';
import { decodeTextures, isValidUuid, maybeJson, normalizeName, normalizeUuid, Textures, wrapHeaders } from './util';
import { CachedResponse, NameLookupResponse, ProfileLookupResponse } from './index';

export type LookupContext = {
	store: CacheStore;
	ctx?: ExecutionContext;
	headers: Headers;
	config: CacheConfig;
	/** Caller sent `Cache-Control: no-cache` and wants us to go back to the upstream. */
	bypass: boolean;
};

/**
 * Two kinds of entry, one per thing we actually know:
 *
 *   profile:<uuid>  the full profile, which already contains the current name
 *   name:<name>     the reverse index, which is the only thing the profile cannot answer
 *
 * There used to be a third, `uuid-to-name-<uuid>`, duplicating a field the profile already had.
 * Every profile lookup wrote it, every name lookup wrote it, and answering from it cost a second
 * read on top of the profile read. Deriving the name from the profile removes both.
 */

export async function getProfile(lookup: LookupContext, uuid: string): Promise<CachedResponse<ProfileLookupResponse>> {
	const id = normalizeUuid(uuid);
	return await cached<ProfileLookupResponse>(
		lookup.store,
		lookup.ctx,
		`profile:${ id }`,
		lookup.config.profile,
		async () => {
			const response = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${ id }?unsigned=false`, {
				headers: wrapHeaders(lookup.headers)
			});
			const data: ProfileLookupResponse | null = await maybeJson(response);
			return { data, status: response.status };
		},
		{ bypass: lookup.bypass, storeNegative: lookup.config.storeNegative }
	);
}

export async function nameToUuid(lookup: LookupContext, name: string): Promise<CachedResponse<NameLookupResponse>> {
	const key = normalizeName(name);
	return await cached<NameLookupResponse>(
		lookup.store,
		lookup.ctx,
		`name:${ key }`,
		lookup.config.name,
		async () => {
			const response = await fetch(`https://api.minecraftservices.com/minecraft/profile/lookup/name/${ name }`, {
				headers: wrapHeaders(lookup.headers)
			});
			const data: NameLookupResponse | null = await maybeJson(response);
			return { data, status: response.status };
		},
		{ bypass: lookup.bypass, storeNegative: lookup.config.storeNegative }
	);
}

/**
 * Served straight off the profile entry — same key, same read, no write of its own.
 */
export async function uuidToName(lookup: LookupContext, uuid: string): Promise<CachedResponse<NameLookupResponse>> {
	const profile = await getProfile(lookup, uuid);
	return {
		ok: profile.ok,
		status: profile.status,
		data: profile.data ? { id: profile.data.id, name: profile.data.name } : null,
		meta: profile.meta
	};
}

export type TexturesResponse = {
	id: string;
	name: string;
	textures: Textures;
};

/**
 * Accepts either spelling. A name costs one extra cached read for the reverse index; a UUID goes
 * straight to the profile entry.
 */
export async function resolveUuid(lookup: LookupContext, nameOrUuid: string): Promise<CachedResponse<NameLookupResponse>> {
	if (isValidUuid(nameOrUuid)) {
		return {
			ok: true,
			status: 200,
			data: { id: normalizeUuid(nameOrUuid), name: '' },
			meta: { cached: false, fetched: Date.now(), expires: Date.now(), expiration: 0 }
		};
	}
	return await nameToUuid(lookup, nameOrUuid);
}

/**
 * Projected off the profile entry like `uuidToName`: the texture URLs live inside the signed
 * `textures` property, so this costs no read or write of its own beyond the profile.
 */
export async function getTextures(lookup: LookupContext, nameOrUuid: string): Promise<CachedResponse<TexturesResponse>> {
	const resolved = await resolveUuid(lookup, nameOrUuid);
	if (!resolved.ok || !resolved.data) {
		return { ok: false, status: resolved.status, data: null, meta: resolved.meta };
	}
	const profile = await getProfile(lookup, resolved.data.id);
	return {
		ok: profile.ok,
		status: profile.status,
		data: profile.data ? {
			id: profile.data.id,
			name: profile.data.name,
			textures: decodeTextures(profile.data.properties)
		} : null,
		meta: profile.meta
	};
}
