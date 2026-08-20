import { CachedResponse } from './index';
import { CacheConfig, TtlProfile } from './config';

/**
 * Sets the headers that let Cloudflare answer without invoking us at all.
 *
 * With Workers Caching enabled (see `[cache]` in wrangler.toml) a hit here never runs the Worker,
 * so it never reads KV. `stale-while-revalidate` extends that: past `max-age` the edge keeps
 * answering from its copy and refreshes with a single background request, and `stale-if-error`
 * keeps it serving if we or the upstream fall over.
 */
export function sendResponse<T>(response: CachedResponse<T>, ttl: TtlProfile, config: CacheConfig): Response {
	return Response.json(response, {
		headers: {
			'Cache-Control': cacheControl(response, ttl, config),
			'Last-Modified': new Date(response.meta.fetched).toUTCString(),
			// Where this answer came from inside the Worker. Cloudflare's own Cf-Cache-Status
			// covers the layer in front, which is the one that decides whether we ran at all.
			'X-Cache': (response.meta.source ?? 'origin').toUpperCase()
		}
	});
}

function cacheControl<T>(response: CachedResponse<T>, ttl: TtlProfile, config: CacheConfig): string {
	// An upstream blip is held just long enough to blunt a retry storm, and never longer.
	if (response.meta.transient) {
		return `public, max-age=${ config.errorEdge }`;
	}
	// "No such player" is cheap to re-derive and we deliberately do not persist it in KV, so the
	// edge is the only thing standing between name enumeration and the upstream.
	if (!response.ok) {
		return `public, max-age=${ config.negativeEdge }`;
	}
	return `public, max-age=${ ttl.edge }, stale-while-revalidate=${ ttl.soft }, stale-if-error=${ ttl.hard }`;
}

export function errorBody(message: string, status: number = 400): CachedResponse<any> {
	return {
		ok: false,
		status: status,
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

/** A rejected request is the caller's fault and never changes, so let the edge absorb repeats. */
export function sendError(message: string, status: number = 400): Response {
	return Response.json(errorBody(message, status), {
		status: status,
		headers: {
			'Cache-Control': 'public, max-age=3600'
		}
	});
}
