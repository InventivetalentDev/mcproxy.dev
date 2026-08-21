-- WITHOUT ROWID makes `key` the clustered B-tree instead of a separate index. D1 bills an extra
-- written row for each index a write touches, so this is the difference between one and two rows
-- written per upsert.
--
-- There is deliberately no index on `expires`: it is only ever used as a read filter, and indexing
-- it would add back the second written row this table exists to avoid.
CREATE TABLE IF NOT EXISTS cache (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	expires INTEGER NOT NULL
) WITHOUT ROWID;
