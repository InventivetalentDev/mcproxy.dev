/**
 * Cache tuning.
 *
 * KV bills per operation, and writes cost 10x reads ($5.00 vs $0.50 per million), so the
 * numbers below are the main lever on the bill. `soft` is the one that matters most: a key is
 * rewritten at most once per soft period, so halving `soft` doubles the write volume.
 *
 * Every value can be overridden from `[vars]` in wrangler.toml, so usage can be dialled back
 * without a code change or a redeploy of the logic.
 */

export type TtlProfile = {
	/** Seconds before the entry is refreshed in the background. Sets how often we write to KV. */
	soft: number;
	/** Seconds before KV drops the entry. Anything within this window can still be served stale. */
	hard: number;
	/** Seconds Cloudflare may serve the response without invoking the Worker at all. */
	edge: number;
};

export type CacheConfig = {
	profile: TtlProfile;
	name: TtlProfile;
	/** Seconds a "no such player" answer is held at the edge. */
	negativeEdge: number;
	/** Seconds an upstream failure is held at the edge, to blunt retry storms. */
	errorEdge: number;
	/**
	 * Persist 404s in KV as well. Off by default: someone walking the name space would otherwise
	 * cost one KV write per unique miss, which is unbounded and entirely attacker-controlled.
	 */
	storeNegative: boolean;
	/**
	 * Honour `Cache-Control: no-cache` from callers. Off by default: it is an unauthenticated way
	 * to force a KV read, a KV write and an upstream call per request, which is the exact cost
	 * everything else here exists to avoid. Browsers send it on a hard refresh.
	 */
	allowBypass: boolean;
};

/** KV rejects an expirationTtl below this, and rate limits writes to one per key per second. */
export const MIN_KV_TTL = 60;

export const DEFAULT_CONFIG: CacheConfig = {
	// Skins and capes change rarely, but people do expect to see their own change land.
	profile: { soft: 60 * 60, hard: 7 * 24 * 60 * 60, edge: 5 * 60 },
	// Mojang only allows a name change every 30 days, so this can be held far longer.
	name: { soft: 6 * 60 * 60, hard: 7 * 24 * 60 * 60, edge: 60 * 60 },
	negativeEdge: 60,
	errorEdge: 10,
	storeNegative: false,
	allowBypass: false
};

function num(raw: string | undefined, fallback: number): number {
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
	if (raw === undefined) return fallback;
	return raw === 'true' || raw === '1';
}

export function resolveConfig(env: Env): CacheConfig {
	const d = DEFAULT_CONFIG;
	return {
		profile: {
			soft: num(env.TTL_PROFILE_SOFT, d.profile.soft),
			hard: Math.max(MIN_KV_TTL, num(env.TTL_PROFILE_HARD, d.profile.hard)),
			edge: num(env.TTL_PROFILE_EDGE, d.profile.edge)
		},
		name: {
			soft: num(env.TTL_NAME_SOFT, d.name.soft),
			hard: Math.max(MIN_KV_TTL, num(env.TTL_NAME_HARD, d.name.hard)),
			edge: num(env.TTL_NAME_EDGE, d.name.edge)
		},
		negativeEdge: num(env.TTL_NEGATIVE_EDGE, d.negativeEdge),
		errorEdge: num(env.TTL_ERROR_EDGE, d.errorEdge),
		storeNegative: bool(env.KV_STORE_NEGATIVE, d.storeNegative),
		allowBypass: bool(env.ALLOW_CACHE_BYPASS, d.allowBypass)
	};
}
