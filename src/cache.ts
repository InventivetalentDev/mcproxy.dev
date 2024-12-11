import { sanitizeKey } from './util';
import { CachedResponse } from './index';

export async function cachedFunction<T>(env: Env, key: string, func: () => Promise<T | null>, expiration: number = 60): Promise<CachedResponse<T>> {
	key = sanitizeKey(key);
	const cached: CachedResponse<T> | null = await env.PROXY_CACHE.get(key, { type: 'json', cacheTtl: expiration });
	if (cached) {
		cached.meta.cached = true;
		return cached;
	}
	const data = await func();
	const wrapped: CachedResponse<T> = {
		ok: true,
		data: data,
		meta: {
			cached: false,
			fetched: Date.now(),
			expires: Date.now() + (expiration * 1000),
			expiration: expiration
		}
	};
	await env.PROXY_CACHE.put(key, JSON.stringify(wrapped), {
		expirationTtl: expiration
	});
	return wrapped;
}

// async function cachedFetch<T>(env: Env, key: string, request: RequestInfo | URL, expiration: number = 60): Promise<CachedResponse<T>> {
// 	key = sanitizeKey(key);
// 	console.log(key);
// 	const cached: CachedResponse<T> | null = await env.PROXY_CACHE.get(key, { type: 'json' });
// 	if (cached) {
// 		cached.meta.cached = true;
// 		return cached;
// 	}
// 	const response = await fetch(request);
// 	// if (!response.ok) {
// 	// 	throw new Error(`Failed to fetch: ${ response.status }`);
// 	// }
// 	let json: T | null = null;
// 	try {
// 		json = await response.json();
// 	} catch (e) {
// 		console.error(e);
// 	}
// 	console.log(json);
// 	const wrapped = await storeCached<T>(env, key, response.ok, json);
// 	wrapped.meta.cached = false;
// 	return wrapped;
// }



export const EXPIRATION_PROFILE = 60;
export const EXPIRATION_NAME_LOOKUP = 60 * 15;
export const EXPIRATION_UUID_LOOKUP = 60 * 5;

export async function storeCached<T>(env: Env, key: string, ok: boolean, data: T | null, expiration: number = 60): Promise<CachedResponse<T>> {
	key = sanitizeKey(key);
	const wrapped: CachedResponse<T> = {
		ok: ok,
		data: data,
		meta: {
			fetched: Date.now(),
			expires: Date.now() + (expiration * 1000),
			expiration: expiration
		}
	};
	await env.PROXY_CACHE.put(key, JSON.stringify(wrapped), {
		expirationTtl: expiration
	});
	return wrapped;
}
