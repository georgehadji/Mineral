-- migrate:up
-- Response cache, keyed by request hash. Separate from research.model_runs on
-- purpose: that table is the audit log and has to survive cache eviction, so
-- a run stays readable even once its body is gone. Bodies are stored as the
-- exact text sent and received, not as jsonb, because normalising the JSON
-- would change the bytes the response hash was taken over.
create table research.model_cache (
  request_hash text primary key,
  provider text not null,
  model text not null,
  request_body text not null,
  response_body text not null,
  response_hash text not null,
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(18,8),
  created_at timestamptz not null default now()
);

-- migrate:down
drop table research.model_cache;
