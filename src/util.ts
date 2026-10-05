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

export type Textures = {
	skin?: string;
	cape?: string;
	/** True for the "slim" (Alex) arm model. Only present on the SKIN texture. */
	slim?: boolean;
};

const TEXTURE_HOST = 'textures.minecraft.net';

/**
 * Pulls the texture URLs out of a profile's `textures` property. The value is a base64 JSON blob
 * whose `textures.SKIN.url` and `textures.CAPE.url` point at textures.minecraft.net. Anything that
 * doesn't decode, or points somewhere else, is treated as absent rather than proxied.
 */
export function decodeTextures(properties: { name: string; value: string }[] | undefined): Textures {
	const property = properties?.find(p => p.name === 'textures');
	if (!property) return {};
	let decoded: any;
	try {
		decoded = JSON.parse(atob(property.value));
	} catch (e) {
		return {};
	}
	const textures: Textures = {};
	const skin = textureUrl(decoded?.textures?.SKIN?.url);
	if (skin) {
		textures.skin = skin;
		textures.slim = decoded.textures.SKIN.metadata?.model === 'slim';
	}
	const cape = textureUrl(decoded?.textures?.CAPE?.url);
	if (cape) {
		textures.cape = cape;
	}
	return textures;
}

/** Only ever proxy Mojang's own texture host, whatever the profile claims. */
function textureUrl(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	try {
		const url = new URL(raw);
		if (url.hostname !== TEXTURE_HOST) return undefined;
		url.protocol = 'https:';
		return url.toString();
	} catch (e) {
		return undefined;
	}
}
