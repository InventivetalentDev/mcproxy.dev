import { CachedResponse } from './index';
import { MIN_KV_TTL, TtlProfile } from './config';

/**
 * The persistence layer, behind one interface so the backing store is a deployment choice.
 *
 * Both backends cost exactly one operation per call — a KV get/put, or a D1 single-row read/write —
 * so the difference between them is purely price:
 *
 *                 read                     write                    free per day
 *   Workers KV    $0.50 / million          $5.00 / million          100,000 / 1,000
 *   D1            $0.001 / million rows    $1.00 / million rows     5,000,000 / 100,000
 *
 * That gap only matters for traffic where most lookups are for keys never seen before, because a
 * first-ever lookup costs a write no matter how the TTLs are set. Where repeats dominate, the TTLs
 * do the work and either store is fine.
 */
export type CacheStore = {
	readonly name: 'kv' | 'd1';
	get<T>(key: string, ttl: TtlProfile): Promise<CachedResponse<T> | null>;
	put<T>(key: string, entry: CachedResponse<T>, ttl: TtlProfile): Promise<void>;
};

/** Uses D1 when the binding is present, otherwise KV. Switching stores is a wrangler.toml edit. */
export function resolveStore(env: Env): CacheStore {
	return env.CACHE_DB ? d1Store(env.CACHE_DB) : kvStore(env.PROXY_CACHE);
}

export function kvStore(namespace: KVNamespace): CacheStore {
	return {
		name: 'kv',
		async get<T>(key: string, ttl: TtlProfile) {
			// cacheTtl keeps the value in KV's own edge tier. It cuts latency, not the read bill —
			// every get() is billed whether or not that tier serves it.
			return await namespace.get<CachedResponse<T>>(key, {
				type: 'json',
				cacheTtl: Math.max(MIN_KV_TTL, ttl.soft)
			});
		},
		async put<T>(key: string, entry: CachedResponse<T>, ttl: TtlProfile) {
			await namespace.put(key, JSON.stringify(entry), {
				expirationTtl: Math.max(MIN_KV_TTL, Math.round(ttl.hard))
			});
		}
	};
}

/**
 * The table is `WITHOUT ROWID`, which makes the key the clustered B-tree rather than a separate
 * index. D1 bills an extra written row for every index a write touches, so this halves the cost of
 * the operation that matters: an upsert writes one row, not two. Verified with the `meta` object.
 *
 * Nothing is ever deleted. A DELETE is billed as a written row, so sweeping expired entries would
 * cost as much as writing them in the first place; instead `expires` is applied as a read filter
 * and the row is overwritten the next time that key is looked up. Keys that are never seen again
 * linger as storage, which is the cheapest dimension D1 has ($0.75/GB-month, 5 GB included).
 */
export function d1Store(db: D1Database): CacheStore {
	return {
		name: 'd1',
		async get<T>(key: string) {
			const row = await reader(db)
				.prepare('SELECT value FROM cache WHERE key = ?1 AND expires > ?2')
				.bind(key, Date.now())
				.first<{ value: string }>();
			return row ? (JSON.parse(row.value) as CachedResponse<T>) : null;
		},
		async put<T>(key: string, entry: CachedResponse<T>, ttl: TtlProfile) {
			await db
				.prepare(
					'INSERT INTO cache (key, value, expires) VALUES (?1, ?2, ?3) ' +
						'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires'
				)
				.bind(key, JSON.stringify(entry), Date.now() + Math.round(ttl.hard) * 1000)
				.run();
		}
	};
}

/**
 * Routes reads to the nearest replica where read replication is enabled, and to the primary where
 * it is not, so this is correct either way. Feature-detected because the pinned
 * @cloudflare/workers-types predates the Sessions API.
 */
type Preparer = Pick<D1Database, 'prepare'>;

function reader(db: D1Database): Preparer {
	const withSession = (db as { withSession?: (constraint?: string) => Preparer }).withSession;
	return typeof withSession === 'function' ? withSession.call(db, 'first-unconstrained') : db;
}
