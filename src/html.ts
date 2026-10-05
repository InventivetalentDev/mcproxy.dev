export const HTML_WRAPPER = (content: string) => `<!DOCTYPE html>
<html lang="en">
<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>mcproxy.dev</title>
		<meta name="description" content="Proxy and Cache for common Mojang/Minecraft API endpoints, powered by Cloudflare Workers">
		<link rel="preconnect" href="https://fonts.googleapis.com">
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
		<link href="https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,100;0,300;0,400;0,500;0,700;0,900;1,100;1,300;1,400;1,500;1,700;1,900&display=swap" rel="stylesheet">
		<style>
			body {
				font-family: 'Roboto', sans-serif;
				background: #f9f9f9;
				padding: 20px;
			}

			pre[data-fetch] {
				overflow: auto;
				background: #f4f4f4;
			}

			footer {
				margin-top: 60px;
				text-align: center;
			}
		</style>
</head>
<body>
	<main>
	${ content }
  </main>
  <footer>
  <span>Created by <a href="https://inventivetalent.org" target="_blank">inventivetalent</a> - Not affiliated with Minecraft/Mojang/Microsoft</span>
	</footer>
	<script>
	document.addEventListener('DOMContentLoaded', function() {
		const pres = document.querySelectorAll('pre[data-fetch]');
		pres.forEach(pre => {
			const url = pre.getAttribute('data-fetch');
			fetch(url)
				.then(res => res.json())
				.then(data => {
					pre.textContent = JSON.stringify(data, null, 2);
				})
				.catch(err => {
					pre.textContent = 'Error: ' + err;
				});
	});
		});
	</script>
</body>
</html>
`;

export const INDEX_HTML = HTML_WRAPPER(`
<h1><a href="/">mcproxy.dev</a></h1>
<h2>Proxy and Cache for common Mojang/Minecraft API endpoints, powered by Cloudflare Workers</h2>
<div>
	<table>
		<tr>
			<td>
			<a href="/uuid">/uuid/{name or uuid}</a>
			</td>
			<td>
			Get UUID + Name from Name or UUID
			</td>
		</tr>
		<tr>
			<td>
			<a href="/profile">/profile/{uuid}</a>
			</td>
			<td>
			Get Profile from UUID
			</td>
		</tr>
		<tr>
			<td>
			<a href="/skin">/skin/{name or uuid}</a>
			</td>
			<td>
			Get Skin image from Name or UUID
			</td>
		</tr>
		<tr>
			<td>
			<a href="/cape">/cape/{name or uuid}</a>
			</td>
			<td>
			Get Cape image from Name or UUID
			</td>
		</tr>

	</table>
</div>
`);

export const UUID_HTML = HTML_WRAPPER(`
<h1><a href="/">mcproxy.dev</a></h1>
<h2>Get UUID + Name from Name or UUID</h2>
<div>
	<span>Wildcard</span>
	<ul>
		<li>
			<a href="/uuid/inventivetalent">/uuid/inventivetalent</a>
		</li>
		<li>
			<a href="/uuid/45f50155c09f4fdcb5cee30af2ebd1f0">/uuid/45f50155c09f4fdcb5cee30af2ebd1f0</a>
		</li>
	</ul>

	<span>Explicit</span>
	<ul>
	  <li>
			<a href="/name-to-uuid/inventivetalent">/name-to-uuid/inventivetalent</a>
		</li>
		<li>
			<a href="/uuid-to-name/45f50155c09f4fdcb5cee30af2ebd1f0">/uuid-to-name/45f50155c09f4fdcb5cee30af2ebd1f0</a>
		</li>
	</ul>
</div>
<br/>
<div>
Proxies <code>https://api.minecraftservices.com/minecraft/profile/lookup/name/{name}</code> and <code>https://sessionserver.mojang.com/session/minecraft/profile/{uuid}</code>
</div>
<br/>
<div>
<pre data-fetch="/uuid/inventivetalent">
Loading...
/uuid/inventivetalent
</pre>
</div>
`);

export const PROFILE_HTML = HTML_WRAPPER(`
<h1><a href="/">mcproxy.dev</a></h1>
<h2>Get Profile from UUID</h2>
<div>
	<ul>
		<li>
			<a href="/profile/bcd2033c63ec4bf88aca680b22461340">/profile/bcd2033c63ec4bf88aca680b22461340</a>
		</li>
		<li>
			<a href="/profile/45f50155c09f4fdcb5cee30af2ebd1f0">/profile/45f50155c09f4fdcb5cee30af2ebd1f0</a>
		</li>
	</ul>
</div>
<br/>
<div>
Proxies <code>https://sessionserver.mojang.com/session/minecraft/profile/{uuid}?unsigned=false</code>
</div>
<br/>
<div>
<pre data-fetch="/profile/bcd2033c63ec4bf88aca680b22461340">
Loading...
/profile/bcd2033c63ec4bf88aca680b22461340
</pre>
</div>
`);

export const SKIN_HTML = HTML_WRAPPER(`
<h1><a href="/">mcproxy.dev</a></h1>
<h2>Get Skin image from Name or UUID</h2>
<div>
	<ul>
		<li>
			<a href="/skin/inventivetalent">/skin/inventivetalent</a>
		</li>
		<li>
			<a href="/skin/45f50155c09f4fdcb5cee30af2ebd1f0">/skin/45f50155c09f4fdcb5cee30af2ebd1f0</a>
		</li>
	</ul>
</div>
<br/>
<div>
Resolves the profile via <code>https://sessionserver.mojang.com/session/minecraft/profile/{uuid}</code> and proxies the skin from <code>https://textures.minecraft.net/texture/{hash}</code>. Responds with the PNG itself, or 404 if the player has no skin.
</div>
<br/>
<div>
<img src="/skin/inventivetalent" alt="/skin/inventivetalent" width="128" height="128" style="image-rendering: pixelated;">
</div>
`);

export const CAPE_HTML = HTML_WRAPPER(`
<h1><a href="/">mcproxy.dev</a></h1>
<h2>Get Cape image from Name or UUID</h2>
<div>
	<ul>
		<li>
			<a href="/cape/jeb_">/cape/jeb_</a>
		</li>
		<li>
			<a href="/cape/61699b2ed3274a019f1e0ea8c3f06bc6">/cape/61699b2ed3274a019f1e0ea8c3f06bc6</a>
		</li>
	</ul>
</div>
<br/>
<div>
Resolves the profile via <code>https://sessionserver.mojang.com/session/minecraft/profile/{uuid}</code> and proxies the cape from <code>https://textures.minecraft.net/texture/{hash}</code>. Responds with the PNG itself, or 404 if the player has no cape.
</div>
<br/>
<div>
<img src="/cape/jeb_" alt="/cape/jeb_" width="128" height="64" style="image-rendering: pixelated;">
</div>
`);

export async function rawHtmlResponse(html: string) {
  const init = {
    headers: {
      'content-type': 'text/html;charset=UTF-8',
      // Static, so let the edge serve it instead of invoking the Worker for every visitor.
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  }

  return new Response(html, init)
}
