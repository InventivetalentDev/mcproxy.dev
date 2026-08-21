# Caching and what it costs

Notes from the pass that cut this Worker's storage bill. Prices are from Cloudflare's
[Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/), August 2026.

## The two regimes

A cache has two very different cost profiles, and which one you are in decides everything:

- **Repeat-dominated.** The same keys are looked up over and over. Writes are governed by TTLs: a
  key is rewritten once per TTL period no matter how much traffic it takes. Lengthening TTLs is the
  fix, and it works proportionally.
- **Long-tail.** Most lookups are for keys never seen before. Every one of them costs a write on
  the way in, whatever the TTLs say. **No TTL change helps.** The only lever is the price per write.

mcproxy is long-tail. That has two consequences, and they point in opposite directions:

1. Short TTLs are nearly free, because they only affect the repeat traffic you barely have. Profiles
   refresh every 5 minutes rather than the hour a repeat-dominated service would want.
2. The write volume tracks unique players per day and cannot be cached away. So the store had to
   change.

Check which regime you are in by comparing writes/day against unique keys/day. If they are close,
you are long-tail.

## What the stores charge

|                     | Read                    | Write                   | Free per day        | Storage      |
| ------------------- | ----------------------- | ----------------------- | ------------------- | ------------ |
| **Workers KV**      | $0.50 / million         | $5.00 / million         | 100,000 / **1,000** | $0.50/GB-mo  |
| **D1**              | $0.001 / million rows   | $1.00 / million rows    | 5M / **100,000**    | $0.75/GB-mo  |
| **Workers Cache**   | free                    | free                    | unmetered           | free         |

Monthly allowances before per-unit charges start: KV 10M reads / 1M writes, D1 25B rows read /
50M rows written.

Both stores cost exactly **one operation per lookup** here — a KV `get`/`put`, or a D1 single-row
read/write. The op counts are identical; only the price differs. At 500,000 unique lookups a day:

| Monthly                | Workers KV | D1     |
| ---------------------- | ---------- | ------ |
| 15M reads / 15M writes | **$72.50** | **$0** |

And at 100M writes/month it is $495 against $50. On the free plan the difference is starker still:
1,000 writes/day against 100,000.

## Where it was going

### Profiles were rewritten every 60 seconds

`EXPIRATION_PROFILE` was `60`, passed straight to `expirationTtl` — the lowest value KV accepts.
Any UUID under steady traffic was rewritten every minute: `86,400 ÷ 60 = 1,440 writes/day` for one
UUID. That alone exceeded the entire free daily write allowance.

### One request could cost three writes

`/uuid-to-name/:uuid` went through `uuidToName` → `getProfile`, and each layer wrote its own entry:
`uuid-to-profile`, `name-to-uuid`, and `uuid-to-name` — 2 reads and 3 writes per miss. Two of those
writes were speculative, and `uuid-to-name` duplicated a field the profile entry already carried.

### The same player occupied several keys

Keys came from the raw path segment, so `Notch`, `notch` and `NOTCH` were three entries, as were the
dashed and undashed spellings of a UUID. Each variant paid its own write. (`isValidUuid` also had no
`i` flag, so uppercase UUIDs were rejected outright, and its `[a-f0-9-]{32,36}` pattern accepted a
string of 36 dashes, which normalised to an empty key.)

### Upstream failures were cached like data

A 429 or 502 from Mojang produced `{ok: false, data: null}`, which was written to KV and served for
the full TTL. A momentary upstream wobble cost a write and then became a 15-minute outage of our own.

### Nothing was cached in front of the Worker

Responses carried `Cache-Control`, but a Worker's response is not stored by Cloudflare's cache unless
the Worker opts in. Every request not already in a *browser* cache invoked the Worker and spent a read.

## What changed

### D1 instead of KV

`src/store.ts` puts both backends behind one interface. D1 is used whenever the `CACHE_DB` binding
is present; drop the binding from `wrangler.toml` and it falls back to KV with no code change.

Two decisions there are worth keeping:

**The table is `WITHOUT ROWID`.** D1 bills an extra written row for every index a write touches, and
a plain `TEXT PRIMARY KEY` is implemented as a separate index — so an upsert would write two rows,
one to the table and one to the index. `WITHOUT ROWID` makes the key the clustered B-tree itself.
Confirmed against the live database via the `meta` object: `rows_written: 1`, and the read plans as
`SEARCH cache USING PRIMARY KEY` for `rows_read: 1`.

**Nothing is ever deleted.** A `DELETE` is billed as a written row, so sweeping expired entries would
cost as much as writing them. Instead `expires` is applied as a read filter and the row is
overwritten next time that key is looked up. Keys never seen again linger as storage, which is the
cheapest dimension D1 has. For the same reason there is deliberately **no index on `expires`** —
it would add back the second written row the table shape exists to avoid.

Reads go through `withSession()`, which routes to the nearest replica where
[read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/) is enabled
and to the primary where it is not. It is currently **disabled** on `mcproxy-cache`; turning it on in
the dashboard costs nothing and needs no code change.

### Workers Caching in front of the Worker

`[cache] enabled = true` in `wrangler.toml`. A cache hit is answered **without invoking the Worker**,
so it costs no storage operations at all, and concurrent misses on the same key are collapsed into a
single invocation — which is what keeps a burst on a cold key from becoming a thousand upstream
fetches. `cross_version_cache = true` keeps the cache across deploys.

Responses opt in through `Cache-Control` (`src/response.ts`):

```
public, max-age=60, stale-while-revalidate=300, stale-if-error=604800
```

In a long-tail workload the hit rate here is low by definition, but it costs nothing and it covers
whatever repeats do occur.

### Split soft and hard TTLs

Each entry has a `soft` TTL (when it stops being fresh) and a `hard` TTL (when the store stops
serving it). Between the two, the stored value is returned immediately and refreshed in the
background, so a key is written at most once per soft period and an upstream outage degrades to
slightly-old data rather than errors.

### One key per thing we know

```
profile:<uuid>   the full profile, which already contains the current name
name:<name>      the reverse index, the only thing the profile cannot answer
```

`uuid-to-name` is projected from the profile entry — same key, same read, no write of its own. The
speculative `name-to-uuid` write is gone; only what was asked for is stored. Names are lowercased
and UUIDs stripped of dashes, so every spelling shares one entry.

### Failures are never persisted

429, 5xx, timeouts and thrown fetches are returned but never written. If a stored entry exists it is
served instead. 404s are not written either, by default (`KV_STORE_NEGATIVE`) — persisting them
would cost a write per unique unknown name, which is unbounded and entirely caller-controlled.

For the same reason `Cache-Control: no-cache` from a caller is ignored unless `ALLOW_CACHE_BYPASS`
is set: honouring it is an unauthenticated way to force a read, a write and an upstream call per
request, and browsers send it on a hard refresh.

### A free layer underneath

`src/memory.ts` holds a small bounded per-isolate map and de-duplicates in-flight work. Several URLs
normalise onto one key (`/uuid/Notch`, `/uuid/notch` and `/name-to-uuid/notch` are three edge entries
but one store key), and without in-flight de-duplication a burst on a stale key fires one write per
request — which KV rejects anyway, since it rate limits writes to one key per second.

## Result

Per key held warm by repeat traffic:

| Route                  | Writes/day before | Writes/day after |
| ---------------------- | ----------------- | ---------------- |
| `/profile/:uuid`       | 1,440             | 288              |
| `/uuid-to-name/:uuid`  | 864               | 288 (shared)     |
| `/name-to-uuid/:name`  | 192               | 48               |

Those ratios are the smaller half of the story. The one that matters for this workload is that each
of those writes now costs $1.00/million instead of $5.00/million, against a daily free allowance of
100,000 instead of 1,000.

## Measuring

`Cf-Cache-Status` on a live response says whether the Worker ran at all; `X-Cache` says which layer
inside it answered (`MEMORY`, `D1`, `KV`, `STALE`, `ORIGIN`).

For D1, the [`meta` object](https://developers.cloudflare.com/d1/worker-api/return-object/) on every
query carries `rows_read` and `rows_written` — that is the billing metric, exactly. Dashboard:
Workers & Pages → D1 → `mcproxy-cache` → Metrics → Row Metrics.

## Tuning

Every TTL is a `[vars]` entry in `wrangler.toml`, read by `src/config.ts` and parsed defensively —
the Worker runs correctly with none of them set.

| Want                        | Change                                       |
| --------------------------- | -------------------------------------------- |
| Fresher skins               | Lower `TTL_PROFILE_SOFT` (cheap here)        |
| Fewer writes                | Raise `TTL_*_SOFT`                           |
| Fewer reads                 | Raise `TTL_*_EDGE`                           |
| Less stored data            | Lower `TTL_*_HARD`, at the cost of stale-serving |
| Back to KV                  | Delete the `[[d1_databases]]` block          |

Storage is the one dimension that grows without bound, since rows are never swept. A signed profile
is roughly 1.5–2 KB, so D1's included 5 GB is somewhere around 2.5 million distinct players. If that
becomes the constraint, a scheduled `DELETE FROM cache WHERE expires < ?` in bounded batches is the
answer — just note that it is billed as one written row per deleted row.
