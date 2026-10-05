import { Router } from '@tsndr/cloudflare-worker-router';
import { isValidName, isValidUuid, wantsFresh } from './util';
import { sendError, sendNotFound, sendResponse, sendTexture } from './response';
import { CacheSource } from './cache';
import { resolveConfig } from './config';
import { resolveStore } from './store';
import { getProfile, getTextures, LookupContext, nameToUuid, uuidToName } from './apis';
import { CAPE_HTML, INDEX_HTML, PROFILE_HTML, rawHtmlResponse, SKIN_HTML, UUID_HTML } from './html';

// Env Types
export type Var<T = string> = T
export type Secret<T = string> = T

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
		/** Served past its soft expiry while a refresh runs in the background. */
		stale?: boolean;
		/** Upstream failed and we had nothing to fall back on. Deliberately not persisted. */
		transient?: boolean;
		/** Which layer answered: memory, kv, stale or origin. */
		source?: CacheSource;
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

function lookupContext(env: Env, req: { headers: Headers }, ctx?: ExecutionContext): LookupContext {
	const config = resolveConfig(env);
	return {
		store: resolveStore(env),
		ctx: ctx,
		headers: req.headers,
		config: config,
		bypass: config.allowBypass && wantsFresh(req.headers)
	};
}

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


router.get('/', async () => {
	return await rawHtmlResponse(INDEX_HTML);
});


router.get('/name-to-uuid/:name', async ({ env, req, ctx }) => {
	const name = req.params.name;
	if (!isValidName(name)) {
		return sendError('Invalid name');
	}
	const lookup = lookupContext(env, req, ctx);
	const response = await nameToUuid(lookup, name);
	return sendResponse(response, lookup.config.name, lookup.config);
});

router.get('/uuid-to-name/:uuid', async ({ env, req, ctx }) => {
	const uuid = req.params.uuid;
	if (!isValidUuid(uuid)) {
		return sendError('Invalid UUID');
	}
	const lookup = lookupContext(env, req, ctx);
	const response = await uuidToName(lookup, uuid);
	return sendResponse(response, lookup.config.profile, lookup.config);
});

router.get('/uuid', async () => {
	return await rawHtmlResponse(UUID_HTML);
});

router.get('/uuid/:nameOrUuid', async ({ env, req, ctx }) => {
	const nameOrUuid = req.params.nameOrUuid;
	const lookup = lookupContext(env, req, ctx);
	if (nameOrUuid.length < 32) {
		if (!isValidName(nameOrUuid)) {
			return sendError('Invalid name');
		}
		const response = await nameToUuid(lookup, nameOrUuid);
		return sendResponse(response, lookup.config.name, lookup.config);
	} else {
		if (!isValidUuid(nameOrUuid)) {
			return sendError('Invalid uuid');
		}
		const response = await uuidToName(lookup, nameOrUuid);
		return sendResponse(response, lookup.config.profile, lookup.config);
	}
});

router.get('/profile', async () => {
	return await rawHtmlResponse(PROFILE_HTML);
});

router.get('/profile/:uuid', async ({ env, req, ctx }) => {
	const uuid = req.params.uuid;
	if (!isValidUuid(uuid)) {
		return sendError('Invalid UUID');
	}
	const lookup = lookupContext(env, req, ctx);
	const response = await getProfile(lookup, uuid);
	return sendResponse(response, lookup.config.profile, lookup.config);
});

/**
 * Skin and cape are served as the image itself, so they can go straight into an <img> or a
 * renderer. Both accept a name or a UUID and ride on the cached profile entry.
 */
function isValidNameOrUuid(nameOrUuid: string): boolean {
	return nameOrUuid.length < 32 ? isValidName(nameOrUuid) : isValidUuid(nameOrUuid);
}

async function textureRoute(kind: 'skin' | 'cape', env: Env, req: { headers: Headers; params: Record<string, string> }, ctx?: ExecutionContext): Promise<Response> {
	const nameOrUuid = req.params.nameOrUuid;
	if (!isValidNameOrUuid(nameOrUuid)) {
		return sendError('Invalid name or UUID');
	}
	const lookup = lookupContext(env, req, ctx);
	const response = await getTextures(lookup, nameOrUuid);
	if (!response.ok || !response.data) {
		// Player not found, or the upstream fell over: same body and headers as the JSON routes,
		// but with a real HTTP status so an <img> or a renderer sees the failure instead of 200 + JSON.
		// Mojang answers an unknown UUID with 204, which is a "not found" for our purposes.
		const status = response.meta.transient ? 502 : 404;
		return sendResponse(response, lookup.config.profile, lookup.config, { status });
	}
	const url = response.data.textures[kind];
	if (!url) {
		return sendNotFound(`Player has no ${ kind }`, lookup.config);
	}
	return await sendTexture(url, response, lookup.config.profile, lookup.config);
}

router.get('/skin', async () => {
	return await rawHtmlResponse(SKIN_HTML);
});

router.get('/skin/:nameOrUuid', async ({ env, req, ctx }) => {
	return await textureRoute('skin', env, req, ctx);
});

router.get('/cape', async () => {
	return await rawHtmlResponse(CAPE_HTML);
});

router.get('/cape/:nameOrUuid', async ({ env, req, ctx }) => {
	return await textureRoute('cape', env, req, ctx);
});

// Listen Cloudflare Workers Fetch Event
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return router.handle(request, env, ctx);
	}
};
