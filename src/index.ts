import { Router } from '@tsndr/cloudflare-worker-router';
import { RequestInfo, URL } from '@cloudflare/workers-types/2023-07-01/index';

// Env Types
export type Var<T = string> = T
export type Secret<T = string> = T

// export type Env = {
//     // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
//     // MY_KV_NAMESPACE: KVNamespace
//     //
//     // Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
//     // MY_DURABLE_OBJECT: DurableObjectNamespace
//     //
//     // Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
//     // MY_BUCKET: R2Bucket
//
//     ENVIRONMENT: Var<'dev' | 'prod'>
//
//     SECRET_TOKEN: Secret
// }

// Request Extension
export type ExtReq = {
	userId?: number
}

// Context Extension
export type ExtCtx = {
	//sentry?: Toucan
}

export type CachedResponse<T> = {
	ok: boolean;
	data: T | null;
	meta: {
		cached?: boolean;
		fetched: number;
		expires: number;
		expiration: number;
	}
}

export type NameLookupResponse = {
	id: string;
	name: string;
}

export type ProfileLookupResponse = {
	id: string;
	name: string;
	properties: any[];
}

// Initialize Router
const router = new Router<Env, ExtCtx, ExtReq>();

// Enabling build in CORS support
router.cors();

// // Register global middleware
// router.use(({ env, req }) => {
//     // Intercept if token doesn't match
//     if (req.headers.get('authorization') !== env.SECRET_TOKEN)
//         return new Response(null, { status: 401 })
// })

// Simple get
router.get('/user', () => {
	return Response.json({
		id: 1,
		name: 'John Doe'
	});
});

// Post route with url parameter
router.post('/user/:id', ({ req }) => {

	const userId = req.params.id;

	// Do stuff

	if (!true) {
		return Response.json({
			error: 'Error doing stuff!'
		}, { status: 400 });
	}

	return Response.json({ userId }, { status: 204 });
});

function sanitizeKey(key: string): string {
	return key.replace(/[^a-z0-9-_]/gi, '');
}

function isValidName(name: string): boolean {
	return /^[a-zA-Z0-9_]{1,16}$/.test(name);
}

function isValidUuid(uuid: string): boolean {
	return /^[a-f0-9-]{32,36}$/.test(uuid);
}

async function cachedFunction<T>(env: Env, key: string, func: () => Promise<T | null>, expiration: number = 60): Promise<CachedResponse<T>> {
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

async function maybeJson<T>(response: Response): Promise<T | null> {
	// if (!response.ok) {
	// 	return null;
	// }
	try {
		return await response.json();
	} catch (e) {
		//console.error(e);
	}
	return null;
}

const EXPIRATION_PROFILE = 60;
const EXPIRATION_NAME_LOOKUP = 60 * 15;
const EXPIRATION_UUID_LOOKUP = 60 * 5;

async function storeCached<T>(env: Env, key: string, ok: boolean, data: T | null, expiration: number = 60): Promise<CachedResponse<T>> {
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

function wrapHeaders(headers: Headers): HeadersInit {
	return headers;
}

async function nameToUuid(env: Env, name: string, headers: Headers): Promise<CachedResponse<NameLookupResponse>> {
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
			await storeCached(env, `uuid-to-name-${ data.id }`, true, data, EXPIRATION_UUID_LOOKUP);
		}
		return data;
	}, EXPIRATION_NAME_LOOKUP);
	// return await cachedFetch<NameLookupResponse>(env, `name-to-uuid-${ name }`, `https://api.mojang.com/users/profiles/minecraft/${ name }`);
}

async function getProfile(env: Env, uuid: string, headers: Headers): Promise<CachedResponse<NameLookupResponse>> {
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
		return data;
	}, EXPIRATION_PROFILE);
	// return await cachedFetch<NameLookupResponse>(env, `name-to-uuid-${ name }`, `https://api.mojang.com/users/profiles/minecraft/${ name }`);
}

async function uuidToName(env: Env, uuid: string, headers: Headers): Promise<CachedResponse<NameLookupResponse>> {
	const KEY = `uuid-to-name-${ uuid }`;
	return await cachedFunction<NameLookupResponse>(env, KEY, async () => {
		const cachedProfile = await getProfile(env, uuid, headers);
		if (!cachedProfile.ok || !cachedProfile.data) {
			return null;
		}
		const data = cachedProfile.data;
		await storeCached(env, `name-to-uuid-${ data.name }`, true, {
			id: data.id,
			name: data.name
		}, EXPIRATION_NAME_LOOKUP);
		return {
			id: data.id,
			name: data.name
		};
	}, EXPIRATION_UUID_LOOKUP);
	// return await cachedFetch<NameLookupResponse>(env, `name-to-uuid-${ name }`, `https://api.mojang.com/users/profiles/minecraft/${ name }`);
}


router.get('/name-to-uuid/:name', async ({ env, req }) => {
	const name = req.params.name;
	if (!isValidName(name)) {
		return Response.json(errorBody('Invalid name'), { status: 400 });
	}
	const response = await nameToUuid(env, name, req.headers);
	return sendResponse(response);
});

router.get('/uuid-to-name/:uuid', async ({ env, req }) => {
	const uuid = req.params.uuid;
	if (!isValidUuid(uuid)) {
		return Response.json(errorBody('Invalid UUID'), { status: 400 });
	}
	const response = await uuidToName(env, uuid, req.headers);
	return sendResponse(response);
});


router.get('/uuid/:nameOrUuid', async ({ env, req }) => {
	const nameOrUuid = req.params.nameOrUuid;
	if (nameOrUuid.length < 32) {
		if (!isValidName(nameOrUuid)) {
			return Response.json(errorBody('Invalid name'), { status: 400 });
		}
		const response = await nameToUuid(env, nameOrUuid, req.headers);
		return Response.json(response, {
			headers: {
				'Cache-Control': `public, max-age=${ response.meta.expiration }`
			}
		});
	} else {
		if (!isValidUuid(nameOrUuid)) {
			return Response.json(errorBody('Invalid uuid'), { status: 400 });
		}
		const response = await uuidToName(env, nameOrUuid, req.headers);
		return sendResponse(response);
	}
});

router.get('/profile/:uuid', async ({ env, req }) => {
	const uuid = req.params.uuid;
	if (!isValidUuid(uuid)) {
		return Response.json(errorBody('Invalid UUID'), { status: 400 });
	}
	const response = await getProfile(env, uuid, req.headers);
	return sendResponse(response);
});

router.get('/test', async ({ env, req }) => {
	const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/inventivetalent`, {
		headers: req.headers
	});
	return response;
});

function sendResponse<T>(response: CachedResponse<T>): Response {
	return Response.json(response, {
		headers: {
			'Cache-Control': `public, max-age=${ response.meta.expiration }`,
			'Last-Modified': new Date(response.meta.fetched).toUTCString()
		}
	});
}

function errorBody(message: string): CachedResponse<any> {
	return {
		ok: false,
		data: {
			error: message
		},
		meta: {
			cached: false,
			fetched: Date.now(),
			expires: Date.now() + 1000,
			expiration: 1
		}
	};
}


// // Delete route using a middleware
// router.delete('/user/:id', ({ env, req }) => {
//     if (req.headers.get('authorization') === env.SECRET_TOKEN)
//         return new Response(null, { status: 401 })
//
// }, ({ req }) => {
//
//   const userId = req.params.id
//
//   // Do stuff...
//
//   return Response.json({ userId })
// })

// Listen Cloudflare Workers Fetch Event
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return router.handle(request, env, ctx);
	}
};
