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

	it('rejects a malformed name on the texture routes', async () => {
		for (const kind of ['skin', 'cape']) {
			const response = await SELF.fetch(`https://example.com/${ kind }/not a valid name`);

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ ok: false, data: { error: 'Invalid name or UUID' } });
		}
	});

	it('serves the texture pages as cacheable html', async () => {
		for (const kind of ['skin', 'cape']) {
			const response = await SELF.fetch(`https://example.com/${ kind }`);

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toContain('text/html');
			expect(await response.text()).toContain(`/${ kind }/`);
		}
	});
});
