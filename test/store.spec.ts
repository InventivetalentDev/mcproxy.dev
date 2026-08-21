import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { CacheStore, d1Store, kvStore, resolveStore } from '../src/store';
import { CachedResponse } from '../src/index';
import { DEFAULT_CONFIG, TtlProfile } from '../src/config';

// Exercises the real backends against the local bindings, so the SQL and the KV options are
// actually run rather than mocked. Cache *logic* is covered in cache.spec.ts.

const TTL: TtlProfile = DEFAULT_CONFIG.profile;

function entry(name: string): CachedResponse<{ name: string }> {
	const now = Date.now();
	return {
		ok: true,
		status: 200,
		data: { name: name },
		meta: { cached: false, fetched: now, expires: now + TTL.soft * 1000, expiration: TTL.soft }
	};
}

beforeAll(async () => {
	// Same shape as migrations/0001_create_cache.sql.
	await env.CACHE_DB.prepare(
		'CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL) WITHOUT ROWID'
	).run();
});

beforeEach(async () => {
	await env.CACHE_DB.prepare('DELETE FROM cache').run();
});

const backends: Array<[string, () => CacheStore]> = [
	['kv', () => kvStore(env.PROXY_CACHE)],
	['d1', () => d1Store(env.CACHE_DB)]
];

describe.each(backends)('%s store', (name, make) => {
	it('names itself so X-Cache shows which backend is live', () => {
		expect(make().name).toBe(name);
	});

	it('round-trips an entry', async () => {
		const store = make();
		await store.put(`round-trip-${ name }`, entry('inventivetalent'), TTL);

		const read = await store.get<{ name: string }>(`round-trip-${ name }`, TTL);
		expect(read!.data).toEqual({ name: 'inventivetalent' });
		expect(read!.ok).toBe(true);
	});

	it('returns null for a key it has never seen', async () => {
		expect(await make().get(`absent-${ name }`, TTL)).toBeNull();
	});

	it('overwrites rather than accumulating', async () => {
		const store = make();
		await store.put(`overwrite-${ name }`, entry('before'), TTL);
		await store.put(`overwrite-${ name }`, entry('after'), TTL);

		const read = await store.get<{ name: string }>(`overwrite-${ name }`, TTL);
		expect(read!.data).toEqual({ name: 'after' });
	});
});

describe('d1 store specifics', () => {
	it('upserts in place, so a refreshed key stays one row', async () => {
		const store = d1Store(env.CACHE_DB);
		await store.put('profile:abc', entry('before'), TTL);
		await store.put('profile:abc', entry('after'), TTL);

		const count = await env.CACHE_DB.prepare('SELECT COUNT(*) AS n FROM cache').first<{ n: number }>();
		expect(count!.n).toBe(1);
	});

	it('applies the hard expiry as a read filter', async () => {
		const store = d1Store(env.CACHE_DB);
		await store.put('profile:stale', entry('gone'), TTL);
		// Nothing sweeps expired rows — a DELETE is billed as a write — so the row stays and the
		// filter is what hides it.
		await env.CACHE_DB.prepare('UPDATE cache SET expires = ?1 WHERE key = ?2').bind(Date.now() - 1, 'profile:stale').run();

		expect(await store.get('profile:stale', TTL)).toBeNull();
		const count = await env.CACHE_DB.prepare('SELECT COUNT(*) AS n FROM cache').first<{ n: number }>();
		expect(count!.n).toBe(1);
	});

	it('costs one row read and one row written per operation', async () => {
		const written = await env.CACHE_DB.prepare(
			'INSERT INTO cache (key, value, expires) VALUES (?1, ?2, ?3) ' +
				'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires'
		)
			.bind('profile:cost', '{}', Date.now() + 60_000)
			.run();
		// WITHOUT ROWID keeps this at one: a separate index would add a second written row.
		expect(written.meta.rows_written).toBe(1);

		const read = await env.CACHE_DB.prepare('SELECT value FROM cache WHERE key = ?1 AND expires > ?2')
			.bind('profile:cost', Date.now())
			.all();
		expect(read.meta.rows_read).toBe(1);
	});
});

describe('store selection', () => {
	it('prefers D1 when the binding is present', () => {
		expect(resolveStore(env).name).toBe('d1');
	});

	it('falls back to KV when it is not', () => {
		expect(resolveStore({ PROXY_CACHE: env.PROXY_CACHE } as Env).name).toBe('kv');
	});
});
