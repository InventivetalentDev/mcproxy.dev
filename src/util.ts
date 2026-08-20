export function wrapHeaders(headers: Headers): HeadersInit {
	return headers;
}

export async function maybeJson<T>(response: Response): Promise<T | null> {
	try {
		return await response.json();
	} catch (e) {
		// Upstream returns HTML or an empty body for some errors; the status carries the meaning.
	}
	return null;
}

/**
 * Cache keys are derived from these, so anything that identifies the same player has to collapse
 * onto the same string. `Notch` and `notch`, or a dashed and undashed UUID, used to occupy separate
 * KV entries — duplicate writes for the same data and a hit rate split across the variants.
 */
export function normalizeName(name: string): string {
	return name.toLowerCase();
}

export function normalizeUuid(uuid: string): string {
	return uuid.replace(/-/g, '').toLowerCase();
}

export function isValidName(name: string): boolean {
	return /^[a-zA-Z0-9_]{1,16}$/.test(name);
}

const UUID_PLAIN = /^[0-9a-f]{32}$/i;
const UUID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(uuid: string): boolean {
	return UUID_PLAIN.test(uuid) || UUID_DASHED.test(uuid);
}

/** True when the caller explicitly asked for a fresh value rather than a cached one. */
export function wantsFresh(headers: Headers): boolean {
	const control = headers.get('cache-control');
	if (!control) return false;
	return /(^|,)\s*(no-cache|no-store)\s*(,|$)/i.test(control);
}
