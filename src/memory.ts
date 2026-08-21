/**
 * Isolate-local layer in front of KV.
 *
 * Two jobs, both aimed at keeping `get`/`put` calls off KV:
 *
 * 1. A tiny bounded cache. Several URLs normalise onto one KV key (`/uuid/Notch`, `/uuid/notch`
 *    and `/name-to-uuid/notch` are three edge-cache entries but one KV key), so the edge cache
 *    misses where this one hits. Reads here are free.
 * 2. In-flight de-duplication. Without it a burst against a stale key fires one upstream fetch and
 *    one KV write per request, and KV rate limits writes to one per key per second.
 */

/** Isolates are cheap and short-lived; this only has to absorb bursts, not act as real storage. */
const MAX_ENTRIES = 500;

/** Cap on how long a value is trusted here, independent of its KV TTL, to bound staleness. */
const MAX_TTL_MS = 60_000;

type Entry = {
	value: unknown;
	expires: number;
};

const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<unknown>>();

export function memoryGet<T>(key: string): T | undefined {
	const entry = entries.get(key);
	if (!entry) return undefined;
	if (entry.expires <= Date.now()) {
		entries.delete(key);
		return undefined;
	}
	return entry.value as T;
}

export function memorySet<T>(key: string, value: T, ttlSeconds: number): void {
	if (ttlSeconds <= 0) return;
	// Map iterates in insertion order, so the first key is the oldest.
	if (entries.size >= MAX_ENTRIES) {
		const oldest = entries.keys().next();
		if (!oldest.done) entries.delete(oldest.value);
	}
	entries.delete(key);
	entries.set(key, { value, expires: Date.now() + Math.min(ttlSeconds * 1000, MAX_TTL_MS) });
}

/** Runs `func` once per key at a time; concurrent callers share the same promise. */
export function dedupe<T>(key: string, func: () => Promise<T>): Promise<T> {
	const running = inFlight.get(key);
	if (running) return running as Promise<T>;

	const promise = func().finally(() => {
		inFlight.delete(key);
	});
	inFlight.set(key, promise);
	return promise;
}

/** Test hook — isolates are per-request in the test runner, but state leaks between cases. */
export function resetMemory(): void {
	entries.clear();
	inFlight.clear();
}
