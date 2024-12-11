import { Router } from '@tsndr/cloudflare-worker-router';
import {  isValidName, isValidUuid, maybeJson, sanitizeKey,  wrapHeaders } from './util';
import { errorBody, sendResponse } from './response';
import {
	cachedFunction,
	EXPIRATION_NAME_LOOKUP,
	EXPIRATION_PROFILE,
	EXPIRATION_UUID_LOOKUP,
	storeCached
} from './cache';
import { getProfile, nameToUuid, uuidToName } from './apis';
import { INDEX_HTML, PROFILE_HTML, rawHtmlResponse, UUID_HTML } from './html';

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
	status: number;
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

export type DataAndStatus<T> = {
	status: number;
	data: T;
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




router.get('/',async () => {
	return await rawHtmlResponse(INDEX_HTML);
});


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

router.get('/uuid',async()=>{
	return await rawHtmlResponse(UUID_HTML);
})

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

router.get('/profile',async()=>{
	return await rawHtmlResponse(PROFILE_HTML);
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
