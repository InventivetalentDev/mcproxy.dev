import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { getProfile, LookupContext, nameToUuid, uuidToName } from '../src/apis';
import { DEFAULT_CONFIG, MIN_KV_TTL, resolveConfig } from '../src/config';
import { resetMemory } from '../src/memory';

/**
 * These assert operation *counts*, not just correctness. The whole point of the cache layer is
 * how many times it touches KV, and KV bills per operation, so a regression that adds a write
 * back into a hot path is the bug worth catching.
 */

type FakeKv = {
	binding: KVNamespace;
	ops: { get: number; put: number };
	store: Map<string, string>;
	ttls: Map<string, number>;
};

function fakeKv(): FakeKv {
	const store = new Map<string, string>();
	const ttls = new Map<string, number>();
	const ops = { get: 0, put: 0 };
	const binding = {
		async get(key: string) {
			ops.get++;
			const raw = store.get(key);
			return raw === undefined ? null : JSON.parse(raw);
		},
		async put(key: string, value: string, options?: { expirationTtl?: number }) {
			ops.put++;
			store.set(key, value);
			if (options?.expirationTtl !== undefined) ttls.set(key, options.expirationTtl);
		}
	} as unknown as KVNamespace;
	return { binding, ops, store, ttls };
}

function lookupFor(kv: FakeKv, overrides: Partial<LookupContext> = {}): LookupContext {
	return {
		env: { PROXY_CACHE: kv.binding } as Env,
		ctx: undefined,
		headers: new Headers(),
		config: DEFAULT_CONFIG,
		bypass: false,
		...overrides
	};
}

const PROFILE = { id: '45f50155c09f4fdcb5cee30af2ebd1f0', name: 'inventivetalent', properties: [] };

function respondWith(status: number, body: unknown | null) {
	return vi.fn(async () => new Response(body === null ? '' : JSON.stringify(body), { status: status }));
}

/** Rewrites a stored entry's soft expiry into the past, as if the soft TTL had elapsed. */
function expireSoftly(kv: FakeKv, key: string) {
	const entry = JSON.parse(kv.store.get(key)!);
	entry.meta.expires = Date.now() - 1000;
	kv.store.set(key, JSON.stringify(entry));
}

beforeEach(() => {
	resetMemory();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('profile caching', () => {
	it('writes once on a miss and serves later requests without touching KV again', async () => {
		const kv = fakeKv();
		const upstream = respondWith(200, PROFILE);
		vi.stubGlobal('fetch', upstream);

		const first = await getProfile(lookupFor(kv), PROFILE.id);
		expect(first.ok).toBe(true);
		expect(first.data).toEqual(PROFILE);
		expect(kv.ops).toEqual({ get: 1, put: 1 });

		// The isolate-local layer answers this one, so neither KV nor the upstream is consulted.
		const second = await getProfile(lookupFor(kv), PROFILE.id);
		expect(second.data).toEqual(PROFILE);
		expect(second.meta.source).toBe('memory');
		expect(kv.ops).toEqual({ get: 1, put: 1 });
		expect(upstream).toHaveBeenCalledTimes(1);
	});

	it('does not rewrite an entry that is still fresh', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(200, PROFILE));

		await getProfile(lookupFor(kv), PROFILE.id);
		resetMemory(); // force the next read past the memory layer down to KV

		const second = await getProfile(lookupFor(kv), PROFILE.id);
		expect(second.meta.source).toBe('kv');
		expect(kv.ops.put).toBe(1);
	});

	it('stores with the hard TTL, never below the KV minimum', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(200, PROFILE));

		await getProfile(lookupFor(kv), PROFILE.id);

		const ttl = kv.ttls.get(`profile:${ PROFILE.id }`)!;
		expect(ttl).toBe(DEFAULT_CONFIG.profile.hard);
		expect(ttl).toBeGreaterThanOrEqual(MIN_KV_TTL);
	});

	it('serves a soft-expired entry immediately and refreshes it once', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(200, PROFILE));
		await getProfile(lookupFor(kv), PROFILE.id);
		resetMemory();
		expireSoftly(kv, `profile:${ PROFILE.id }`);

		const renamed = { ...PROFILE, name: 'renamed' };
		const upstream = respondWith(200, renamed);
		vi.stubGlobal('fetch', upstream);

		const stale = await getProfile(lookupFor(kv), PROFILE.id);
		expect(stale.meta.stale).toBe(true);
		expect(stale.data!.name).toBe('inventivetalent');

		// The background refresh lands without a ctx to hold it open, so give it a turn.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(upstream).toHaveBeenCalledTimes(1);
		expect(JSON.parse(kv.store.get(`profile:${ PROFILE.id }`)!).data.name).toBe('renamed');
	});

	it('collapses a burst on one key into a single upstream call and a single write', async () => {
		const kv = fakeKv();
		const upstream = respondWith(200, PROFILE);
		vi.stubGlobal('fetch', upstream);

		await Promise.all(Array.from({ length: 25 }, () => getProfile(lookupFor(kv), PROFILE.id)));

		expect(upstream).toHaveBeenCalledTimes(1);
		expect(kv.ops.put).toBe(1);
	});
});

describe('failures are not persisted', () => {
	it('never writes a rate-limited upstream response to KV', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(429, null));

		const response = await getProfile(lookupFor(kv), PROFILE.id);

		expect(response.ok).toBe(false);
		expect(response.meta.transient).toBe(true);
		expect(kv.ops.put).toBe(0);
		expect(kv.store.size).toBe(0);
	});

	it('falls back to the stale entry when the upstream is failing', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(200, PROFILE));
		await getProfile(lookupFor(kv), PROFILE.id);
		resetMemory();
		expireSoftly(kv, `profile:${ PROFILE.id }`);

		vi.stubGlobal('fetch', respondWith(503, null));
		const stale = await getProfile(lookupFor(kv), PROFILE.id);

		expect(stale.ok).toBe(true);
		expect(stale.data).toEqual(PROFILE);
		expect(kv.ops.put).toBe(1); // still just the original write
	});

	it('does not spend a write on an unknown name', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(404, { errorMessage: 'Not Found' }));

		const response = await nameToUuid(lookupFor(kv), 'thisplayerisfake');

		expect(response.ok).toBe(false);
		expect(kv.ops.put).toBe(0);
	});

	it('persists an unknown name only when explicitly configured to', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(404, { errorMessage: 'Not Found' }));

		const config = { ...DEFAULT_CONFIG, storeNegative: true };
		await nameToUuid(lookupFor(kv, { config: config }), 'thisplayerisfake');

		expect(kv.ops.put).toBe(1);
	});

	it('treats an empty 2xx body as a miss rather than caching a null', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(200, null));

		const response = await nameToUuid(lookupFor(kv), 'someone');

		expect(response.ok).toBe(false);
		expect(kv.ops.put).toBe(0);
	});
});

describe('key normalization', () => {
	it('shares one entry across name casings', async () => {
		const kv = fakeKv();
		const upstream = respondWith(200, { id: PROFILE.id, name: 'inventivetalent' });
		vi.stubGlobal('fetch', upstream);

		await nameToUuid(lookupFor(kv), 'InventiveTalent');
		await nameToUuid(lookupFor(kv), 'inventivetalent');
		await nameToUuid(lookupFor(kv), 'INVENTIVETALENT');

		expect(kv.ops.put).toBe(1);
		expect(upstream).toHaveBeenCalledTimes(1);
		expect([...kv.store.keys()]).toEqual(['name:inventivetalent']);
	});

	it('shares one entry across dashed and undashed uuids', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(200, PROFILE));

		await getProfile(lookupFor(kv), '45f50155-c09f-4fdc-b5ce-e30af2ebd1f0');
		await getProfile(lookupFor(kv), '45F50155C09F4FDCB5CEE30AF2EBD1F0');

		expect(kv.ops.put).toBe(1);
		expect([...kv.store.keys()]).toEqual([`profile:${ PROFILE.id }`]);
	});
});

describe('uuid to name', () => {
	it('answers from the profile entry without a key of its own', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(200, PROFILE));

		const response = await uuidToName(lookupFor(kv), PROFILE.id);

		expect(response.data).toEqual({ id: PROFILE.id, name: PROFILE.name });
		// One read, one write, one key — the old layout cost two reads and three writes here.
		expect(kv.ops).toEqual({ get: 1, put: 1 });
		expect([...kv.store.keys()]).toEqual([`profile:${ PROFILE.id }`]);
	});

	it('reuses an entry a profile lookup already paid for', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(200, PROFILE));

		await getProfile(lookupFor(kv), PROFILE.id);
		const name = await uuidToName(lookupFor(kv), PROFILE.id);

		expect(name.data!.name).toBe(PROFILE.name);
		expect(kv.ops).toEqual({ get: 1, put: 1 });
	});
});

describe('bypass', () => {
	it('goes back to the upstream when the caller sends no-cache', async () => {
		const kv = fakeKv();
		vi.stubGlobal('fetch', respondWith(200, PROFILE));
		await getProfile(lookupFor(kv), PROFILE.id);

		const upstream = respondWith(200, { ...PROFILE, name: 'refreshed' });
		vi.stubGlobal('fetch', upstream);
		const fresh = await getProfile(lookupFor(kv, { bypass: true }), PROFILE.id);

		expect(upstream).toHaveBeenCalledTimes(1);
		expect(fresh.data!.name).toBe('refreshed');
		expect(fresh.meta.source).toBe('origin');
	});
});

describe('config', () => {
	it('refuses caller-driven bypass unless it is turned on', () => {
		expect(resolveConfig({} as Env).allowBypass).toBe(false);
		expect(resolveConfig({ ALLOW_CACHE_BYPASS: 'true' } as Env).allowBypass).toBe(true);
	});

	it('reads tuning from vars and falls back when they are missing or junk', () => {
		const config = resolveConfig({ TTL_PROFILE_SOFT: '900', TTL_NAME_SOFT: 'not-a-number' } as Env);

		expect(config.profile.soft).toBe(900);
		expect(config.name.soft).toBe(DEFAULT_CONFIG.name.soft);
	});

	it('never lets a hard TTL fall below what KV accepts', () => {
		const config = resolveConfig({ TTL_PROFILE_HARD: '5' } as Env);

		expect(config.profile.hard).toBe(MIN_KV_TTL);
	});
});
