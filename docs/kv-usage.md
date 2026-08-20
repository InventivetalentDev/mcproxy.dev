# KV usage and how to keep it down

Notes from the pass that cut this Worker's Workers KV consumption. Prices and limits below are
from Cloudflare's [Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/)
as of August 2026.

## What KV actually charges for

|               | Free plan     | Paid plan                         |
| ------------- | ------------- | --------------------------------- |
| Keys read     | 100,000 / day | 10 million/month, + $0.50/million |
| Keys written  | 1,000 / day   | 1 million/month, + $5.00/million  |
| Stored data   | 1 GB          | 1 GB, + $0.50/GB-month            |

Two things follow, and both shaped the design:

- **Writes cost 10x reads**, and on the free plan the daily write allowance is 1/100th of the read
  allowance. Writes are the constraint; optimise for them first.
- **Billing is per `get()`/`put()` call.** The `cacheTtl` option on a read puts the value in KV's
  own edge tier, which cuts latency but *not* the read bill. The only way to save a read is to not
  make the call.

## Where it was going

### Profiles were rewritten every 60 seconds

`EXPIRATION_PROFILE` was `60`, and that was passed straight to `expirationTtl` — the lowest value
KV accepts. Any UUID under steady traffic was rewritten every minute:

```
86,400 s/day ÷ 60 s = 1,440 writes/day, for one UUID
```

A single continuously-polled profile therefore burned more than the entire free daily write
allowance on its own, and cost about $0.22/month per hot UUID on the paid plan.

### One request could cost three writes

`/uuid-to-name/:uuid` went through `uuidToName` → `getProfile`, and each layer wrote its own entry:

| Step                              | Reads | Writes |
| --------------------------------- | ----- | ------ |
| `get uuid-to-name-<uuid>`          | 1     |        |
| `get uuid-to-profile-<uuid>`       | 1     |        |
| `put uuid-to-profile-<uuid>`       |       | 1      |
| `put name-to-uuid-<name>`          |       | 1      |
| `put uuid-to-name-<uuid>`          |       | 1      |
| **Total on a miss**                | **2** | **3**  |

Two of those writes were speculative — `name-to-uuid` was written on the chance that someone would
later ask for that name, and `uuid-to-name` duplicated a field the profile entry already carried.

### The same player occupied several keys

Keys were built from the raw path segment, so `Notch`, `notch` and `NOTCH` were three entries, as
were the dashed and undashed spellings of a UUID. Every variant paid its own write and split the
hit rate. (`isValidUuid` also had no `i` flag, so uppercase UUIDs were rejected outright.)

### Upstream failures were cached like data

A 429 or a 502 from Mojang produced `{ok: false, data: null}`, which was written to KV and served
for the full TTL. A momentary upstream wobble cost a write and then became a 15-minute outage of
our own.

### Nothing was cached in front of the Worker

Responses carried `Cache-Control`, but a Worker's response is not stored by Cloudflare's cache
unless the Worker opts in. Every request that was not already in a *browser* cache invoked the
Worker and spent at least one KV read.

## What changed

### 1. Workers Caching in front of the Worker

`[cache] enabled = true` in `wrangler.toml`. A cache hit is answered by Cloudflare **without
invoking the Worker at all**, so it costs no KV operations and no CPU. It also collapses
concurrent misses for the same key into a single invocation, so a traffic burst on a cold key
produces one upstream fetch instead of thousands.

`cross_version_cache = true` keeps the cache across deploys; without it the Worker version is part
of the cache key and every deploy starts cold.

Responses opt in through `Cache-Control` (`src/response.ts`):

```
public, max-age=300, stale-while-revalidate=3600, stale-if-error=604800
```

Past `max-age` the edge keeps answering from its copy and refreshes with one background request;
`stale-if-error` means a Mojang outage is invisible for up to a week.

This is the single biggest lever. KV reads stop scaling with request volume and start scaling with
*colos × edge TTL*, which is bounded.

Note that with caching enabled every request is billed at the standard Workers request rate,
including hits. For eyeball traffic like this those requests were already billable, so it adds
nothing — it removes the CPU and the KV operation.

### 2. Split soft and hard TTLs

Each entry now has a `soft` TTL (when it stops being fresh) and a `hard` TTL (when KV drops it).
Between the two, the stored value is returned immediately and refreshed in the background.

A key is written **at most once per soft period**, regardless of traffic. `soft` went from 60s to
1h for profiles and 6h for name lookups; `hard` is a week, which is what makes serving stale during
an outage possible.

### 3. One key per thing we know

```
profile:<uuid>   the full profile, which already contains the current name
name:<name>      the reverse index, the only thing the profile cannot answer
```

`uuid-to-name` is now projected from the profile entry — same key, same read, no write of its own.
The speculative `name-to-uuid` write on the profile path is gone; only what was actually asked for
is stored. Names are lowercased and UUIDs stripped of dashes, so every spelling shares one entry.

### 4. Failures are never persisted

429, 5xx, timeouts and thrown fetches are returned but never written to KV. If a stored entry
exists it is served instead, so an upstream outage degrades to slightly-old data.

404s are not written either, by default (`KV_STORE_NEGATIVE`). Persisting them would cost one write
per unique unknown name, which is unbounded and entirely caller-controlled — anyone walking the
name space could drain the write quota. Negative answers are held at the edge and in isolate memory.

### 5. A free layer under the edge

`src/memory.ts` holds a small bounded map per isolate and de-duplicates in-flight work. It matters
because several URLs normalise onto one KV key (`/uuid/Notch`, `/uuid/notch` and
`/name-to-uuid/notch` are three edge entries but one KV key), and because without in-flight
de-duplication a burst on a stale key fires one write per request — which KV rejects anyway, since
it rate limits writes to one per key per second.

## Result

Per key held warm by continuous traffic:

| Route                  | Writes/day before | Writes/day after | Factor |
| ---------------------- | ----------------- | ---------------- | ------ |
| `/profile/:uuid`       | 1,440             | 24               | 60x    |
| `/uuid-to-name/:uuid`  | 864               | 24 (shared)      | 36x    |
| `/name-to-uuid/:name`  | 192               | 4                | 48x    |

Reads no longer scale with request volume at all — the Worker runs at most once per edge TTL per
colo per URL, and each run costs one read rather than one or two.

## Which problem do you actually have

The numbers above only apply to *repeat* traffic on the same keys. A first-ever lookup costs one
write no matter what, so:

- **If writes/day is much larger than unique keys/day**, the traffic is hot-key dominated and the
  TTL work above is the fix.
- **If writes/day is close to unique keys/day**, the traffic is long-tail dominated — mostly
  one-off UUIDs — and no TTL change will help. The lever there is a cheaper store.

Check it in the dashboard under Workers & Pages → KV → `mcproxy` → Metrics, or via the
[GraphQL analytics API](https://developers.cloudflare.com/kv/observability/metrics-analytics/).
On a live response, `Cf-Cache-Status` tells you whether the Worker ran and `X-Cache` tells you
which layer inside it answered (`MEMORY`, `KV`, `STALE`, `ORIGIN`).

## Cheaper stores, if it comes to that

| Store                | Reads                          | Writes                        | Storage           | Free/day (reads / writes) |
| -------------------- | ------------------------------ | ----------------------------- | ----------------- | ------------------------- |
| **Workers KV**       | $0.50/M (10M/mo incl.)         | $5.00/M (1M/mo incl.)         | $0.50/GB-mo       | 100,000 / **1,000**       |
| **Workers Cache**    | free                           | free                          | free              | unmetered                 |
| **D1**               | $0.001/M rows (25B/mo incl.)   | $1.00/M rows (50M/mo incl.)   | $0.75/GB-mo       | 5,000,000 / **100,000**   |
| **Durable Objects**  | $0.20/M units (4 KB)           | $1.00/M units (4 KB)          | $0.20/GB-mo       | — (plus DO request cost)  |
| **R2**               | $0.36/M class B (10M/mo incl.) | $4.50/M class A (1M/mo incl.) | $0.015/GB-mo      | — (monthly, not daily)    |

**D1 is the strong candidate** if writes are still the binding constraint. Reads are 500x cheaper
than KV, writes 5x cheaper, and on the free plan the daily write budget is **100x larger** (100,000
vs 1,000). It reads well here because the data is small, uniform and keyed — a two-column table
does everything the namespace does. The historical objection was that D1 is single-region, but
[read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) is now
automatic in every region at no extra cost, and with Workers Caching absorbing the repeat traffic
the remaining queries are rare enough that the latency difference barely shows.

`src/cache.ts` was written with that in mind: `readKv` and `writeKv` are the only two functions
that touch the store, so swapping the backing store means replacing those two and leaving the
soft/hard TTL, stale-serving and de-duplication logic alone.

**R2** is worth it only if storage dominates — it is 33x cheaper per GB, but its writes cost about
the same as KV's. That would be the choice for caching skin *textures*, not these JSON blobs.

**Durable Objects** are cheaper than KV per operation but add a per-request DO invocation on top,
and the coordination they buy is not needed here.

**Workers Cache remains the cheapest storage available**, because it is free and it answers before
the Worker runs. Everything above is only for what escapes it.

## Tuning without a deploy

Every TTL is a `[vars]` entry in `wrangler.toml`, read by `src/config.ts` and parsed defensively —
the Worker runs correctly with none of them set. To halve write volume, double the `*_SOFT` values.
To cut KV reads, raise the `*_EDGE` values.

If stored data becomes the problem instead, lower `TTL_PROFILE_HARD`. A signed profile is roughly
1.5–2 KB, so the 1 GB included storage is somewhere around 500,000 profiles held at once.
