import {
	cachedFunction,
	EXPIRATION_NAME_LOOKUP,
	EXPIRATION_PROFILE,
	EXPIRATION_UUID_LOOKUP,
	storeCached
} from './cache';
import { maybeJson, wrapHeaders } from './util';
import { CachedResponse, NameLookupResponse, ProfileLookupResponse } from './index';

export async function nameToUuid(env: Env, name: string, headers: Headers): Promise<CachedResponse<NameLookupResponse>> {
	const KEY = `name-to-uuid-${ name }`;
	return await cachedFunction<NameLookupResponse>(env, KEY, async () => {
		const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${ name }`, {
			headers: wrapHeaders(headers)
		});
		// if (!response.ok) {
		// 	return null;
		// }
		const data: NameLookupResponse | null = await maybeJson(response);
		if (data) {
			await storeCached(env, `uuid-to-name-${ data.id }`, response.status, data, EXPIRATION_UUID_LOOKUP);
		}
		return { data, status: response.status };
	}, EXPIRATION_NAME_LOOKUP);
	// return await cachedFetch<NameLookupResponse>(env, `name-to-uuid-${ name }`, `https://api.mojang.com/users/profiles/minecraft/${ name }`);
}

export async function getProfile(env: Env, uuid: string, headers: Headers): Promise<CachedResponse<NameLookupResponse>> {
	const KEY = `uuid-to-profile-${ uuid }`;
	return await cachedFunction<ProfileLookupResponse>(env, KEY, async () => {
		const response = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${ uuid }?unsigned=false`, {
			headers: wrapHeaders(headers)
		});
		// if (!response.ok) {
		// 	return null;
		// }
		const data: ProfileLookupResponse | null = await maybeJson(response);
		// await storeCached(env, `uuid-to-name-${ data.id }`, true, {
		// 	id: data.id,
		// 	name: data.name
		// });
		// await storeCached(env, `name-to-uuid-${ data.name }`, true, {
		// 	id: data.id,
		// 	name: data.name
		// });
		return { data, status: response.status };
	}, EXPIRATION_PROFILE);
	// return await cachedFetch<NameLookupResponse>(env, `name-to-uuid-${ name }`, `https://api.mojang.com/users/profiles/minecraft/${ name }`);
}

export async function uuidToName(env: Env, uuid: string, headers: Headers): Promise<CachedResponse<NameLookupResponse>> {
	const KEY = `uuid-to-name-${ uuid }`;
	return await cachedFunction<NameLookupResponse>(env, KEY, async () => {
		const cachedProfile = await getProfile(env, uuid, headers);
		if (!cachedProfile.ok || !cachedProfile.data) {
			return { data: null, status: cachedProfile.status };
		}
		const data = cachedProfile.data;
		await storeCached(env, `name-to-uuid-${ data.name }`, cachedProfile.status, {
			id: data.id,
			name: data.name
		}, EXPIRATION_NAME_LOOKUP);
		return {
			data: {
				id: data.id,
				name: data.name
			},
			status: cachedProfile.status
		};
	}, EXPIRATION_UUID_LOOKUP);
	// return await cachedFetch<NameLookupResponse>(env, `name-to-uuid-${ name }`, `https://api.mojang.com/users/profiles/minecraft/${ name }`);
}
