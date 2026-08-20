// test/index.spec.ts
import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// Routes that never reach KV: the static pages and the input validation that runs before any
// lookup. Cache behaviour is covered in cache.spec.ts against a counting KV stub.

describe('static pages', () => {
	it('serves the index as cacheable html', async () => {
		const response = await SELF.fetch('https://example.com/');

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		// Without this the Worker would be invoked for every visit to a page that never changes.
		expect(response.headers.get('cache-control')).toContain('max-age=3600');
		expect(await response.text()).toContain('mcproxy.dev');
	});
});

describe('validation', () => {
	it('rejects a malformed name and lets the edge remember the rejection', async () => {
		const response = await SELF.fetch('https://example.com/name-to-uuid/not a valid name');

		expect(response.status).toBe(400);
		expect(response.headers.get('cache-control')).toContain('max-age=');
		expect(await response.json()).toMatchObject({ ok: false, data: { error: 'Invalid name' } });
	});

	it('rejects a uuid that is the right length but not a uuid', async () => {
		const response = await SELF.fetch(`https://example.com/profile/${ '-'.repeat(36) }`);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ ok: false, data: { error: 'Invalid UUID' } });
	});

	it('accepts both uuid spellings', async () => {
		for (const uuid of ['45f50155c09f4fdcb5cee30af2ebd1f0', '45f50155-c09f-4fdc-b5ce-e30af2ebd1f0', '45F50155C09F4FDCB5CEE30AF2EBD1F0']) {
			const response = await SELF.fetch(`https://example.com/profile/${ uuid }`);
			expect(response.status, uuid).not.toBe(400);
		}
	});
});
