import { CachedResponse } from './index';

export function sendResponse<T>(response: CachedResponse<T>): Response {
	return Response.json(response, {
		headers: {
			'Cache-Control': `public, max-age=${ response.meta.expiration }`,
			'Last-Modified': new Date(response.meta.fetched).toUTCString()
		}
	});
}

export function errorBody(message: string): CachedResponse<any> {
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
