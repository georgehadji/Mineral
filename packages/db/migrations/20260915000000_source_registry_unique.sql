-- migrate:up
-- A source is a registry entry, not an event: two rows named "SEC EDGAR" are
-- always a bug, and ingestion needs the constraint to upsert idempotently.
alter table evidence.sources add constraint uq_sources_source_name unique (source_name);

-- migrate:down
alter table evidence.sources drop constraint uq_sources_source_name;
