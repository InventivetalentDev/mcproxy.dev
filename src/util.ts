import { CachedResponse } from './index';

export function wrapHeaders(headers: Headers): HeadersInit {
	return headers;
}

export async function maybeJson<T>(response: Response): Promise<T | null> {
	// if (!response.ok) {
	// 	return null;
	// }
	try {
		return await response.json();
	} catch (e) {
		//console.error(e);
	}
	return null;
}

export function sanitizeKey(key: string): string {
	return key.replace(/[^a-z0-9-_]/gi, '');
}

export function isValidName(name: string): boolean {
	return /^[a-zA-Z0-9_]{1,16}$/.test(name);
}

export function isValidUuid(uuid: string): boolean {
	return /^[a-f0-9-]{32,36}$/.test(uuid);
}


