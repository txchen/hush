# Publish mutations under one vault revision

Hush targets a single owner's vault containing at most 500 small secrets. Each user-initiated mutation checks one vault-wide revision and advances it atomically with its data changes and audit event. This deliberately permits conflicts between otherwise unrelated edits in exchange for a simple complete-snapshot rotation protocol.

D1 `batch()` executes the publication as one transaction. The first statement increments the revision only if the expected revision matches; otherwise it violates a named CHECK constraint, forcing rollback of every following statement. An update that merely affects zero rows would not provide this guarantee. Consistent snapshots come from a read batch, with sessions starting on the primary to avoid checking device revocation against stale replicas.

Entity documents occupy individual rows rather than one oversized vault blob. Changed rows are sent in bounded JSON chunks and inserted through `json_each`, keeping bound values below D1's per-value limit and batch statement counts low. Profiles are validated against the same revision-protected snapshot. Read audit events and device activity do not increment the vault revision.

References: [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
