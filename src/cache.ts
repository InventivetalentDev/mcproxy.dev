import { CachedResponse, DataAndStatus } from './index';
import { MIN_KV_TTL, TtlProfile } from './config';
import { dedupe, memoryGet, memorySet } from './memory';

export type CacheSource = 'memory' | 'kv' | 'stale' | 'origin';

export type CacheOptions = {
	/** Ignore the cached copy and revalidate against the upstream (`Cache-Control: no-cache`). */
	bypass?: boolean;
	/** Persist definitive negatives (404). Transient failures are never persisted regardless. */
	storeNegative?: boolean;
};

/**
 * Read-through cache over KV with a split TTL.
 *
 * `soft` is when the value stops being fresh, `hard` is when KV drops it. Between the two we hand
 * back the stale value straight away and refresh in the background, so a key costs at most one
 * write per soft period no matter how much traffic it takes, and an upstream outage degrades to
 * slightly-old data instead of errors.
 */
export async function cached<T>(
	env: Env,
	ctx: ExecutionContext | undefined,
	key: string,
	ttl: TtlProfile,
	fetcher: () => Promise<DataAndStatus<T | null>>,
	options: CacheOptions = {}
): Promise<CachedResponse<T>> {
	if (!options.bypass) {
		const hot = memoryGet<CachedResponse<T>>(key);
		if (hot) return tag(hot, 'memory');

		const stored = await readKv<T>(env, key, ttl);
		if (stored) {
			if (stored.meta.expires > Date.now()) {
				memorySet(key, stored, ttl.soft);
				return tag(stored, 'kv');
			}
			// Soft-expired. The read is already paid for, so serve it and refresh out of band —
			// the one write that follows is shared by every request until the next soft expiry.
			background(ctx, revalidate(env, key, ttl, fetcher, options, stored));
			return tag(stored, 'stale');
		}
	}

	return await revalidate(env, key, ttl, fetcher, options, null);
}

function revalidate<T>(
	env: Env,
	key: string,
	ttl: TtlProfile,
	fetcher: () => Promise<DataAndStatus<T | null>>,
	options: CacheOptions,
	stored: CachedResponse<T> | null
): Promise<CachedResponse<T>> {
	// Collapse concurrent refreshes: one upstream call and one KV write, not one per request.
	return dedupe(key, async () => {
		let result: DataAndStatus<T | null>;
		try {
			result = await fetcher();
		} catch (e) {
			console.error(`upstream threw for ${ key }`, e);
			return stored ? tag(stored, 'stale') : transientEntry<T>(502);
		}

		const { data, status } = result;

		// Never persist a blip. Writing a 429 or a 502 into KV costs a write and then serves that
		// failure to everyone until it expires, which is how a short upstream wobble turns into a
		// long outage of our own.
		if (isTransient(status)) {
			return stored ? tag(stored, 'stale') : transientEntry<T>(status);
		}

		const entry = buildEntry<T>(status, data, ttl);
		// Memory is free and short-lived, so hold definitive negatives there too — otherwise a
		// walk through the name space re-hits the upstream for every repeat of the same miss.
		memorySet(key, entry, ttl.soft);
		if (entry.ok || options.storeNegative) {
			await writeKv(env, key, entry, ttl);
		}
		return tag(entry, 'origin');
	});
}

async function readKv<T>(env: Env, key: string, ttl: TtlProfile): Promise<CachedResponse<T> | null> {
	try {
		// cacheTtl keeps the value in KV's own edge tier. It cuts latency, not the read bill —
		// every get() is billed whether or not that tier serves it.
		return await env.PROXY_CACHE.get<CachedResponse<T>>(key, {
			type: 'json',
			cacheTtl: Math.max(MIN_KV_TTL, ttl.soft)
		});
	} catch (e) {
		// A read failure (quota exhausted, transient KV error) should cost freshness, not the request.
		console.error(`KV read failed for ${ key }`, e);
		return null;
	}
}

async function writeKv<T>(env: Env, key: string, entry: CachedResponse<T>, ttl: TtlProfile): Promise<void> {
	try {
		await env.PROXY_CACHE.put(key, JSON.stringify(entry), {
			expirationTtl: Math.max(MIN_KV_TTL, Math.round(ttl.hard))
		});
	} catch (e) {
		// Same reasoning as reads, and this is the path that trips first when the daily write
		// allowance runs out: degrade to an uncached proxy rather than failing outright.
		console.error(`KV write failed for ${ key }`, e);
	}
}

function buildEntry<T>(status: number, data: T | null, ttl: TtlProfile): CachedResponse<T> {
	const fetched = Date.now();
	return {
		// An empty body on a 2xx is not a hit — the upstream answers "no such player" that way
		// often enough that treating it as success would cache a permanent null.
		ok: Math.floor(status / 100) === 2 && data !== null,
		status: status,
		data: data,
		meta: {
			cached: false,
			fetched: fetched,
			expires: fetched + ttl.soft * 1000,
			expiration: ttl.soft
		}
	};
}

/** An upstream failure we refuse to persist. Zero expiration marks it as not cacheable downstream. */
function transientEntry<T>(status: number): CachedResponse<T> {
	const fetched = Date.now();
	return {
		ok: false,
		status: status,
		data: null,
		meta: {
			cached: false,
			source: 'origin',
			transient: true,
			fetched: fetched,
			expires: fetched,
			expiration: 0
		}
	};
}

function isTransient(status: number): boolean {
	return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Copies rather than mutates: the same object is shared by the memory cache and every caller. */
function tag<T>(entry: CachedResponse<T>, source: CacheSource): CachedResponse<T> {
	return {
		...entry,
		meta: {
			...entry.meta,
			cached: source !== 'origin',
			stale: source === 'stale',
			source: source
		}
	};
}

function background(ctx: ExecutionContext | undefined, promise: Promise<unknown>): void {
	const swallowed = promise.then(
		() => undefined,
		() => undefined
	);
	// Without a ctx (direct handler invocation in tests) the refresh still runs, it just is not
	// kept alive past the response.
	if (ctx) ctx.waitUntil(swallowed);
}
