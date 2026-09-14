# Mineral

Continuous investment-research platform. Turns fragmented financial, corporate, industrial, commodity and geopolitical information into a versioned, evidence-backed investment thesis. First domain: rare earths and permanent-magnet supply chains.

Evidence before prose. Deterministic calculations before LLM conclusions. Versioned research instead of static reports.

## Layout

| Path | Purpose |
|---|---|
| `docs/spec/` | Authoritative product and architecture spec (brief, rules, original schema draft, domain types, events, recipe) |
| `docs/architecture/` | Architecture understanding report and decisions |
| `docs/domain/` | Domain semantics (time axes, epistemic status, source tiers) |
| `packages/db/migrations/` | PostgreSQL schema, plain SQL, dbmate format |
| `packages/db/tests/` | Schema invariant checks, plain SQL |

## Schema check

```bash
docker run -d --name mineral-pg -e POSTGRES_PASSWORD=mineral -p 55432:5432 postgres:16
```

```bash
sed -n '/-- migrate:up/,/-- migrate:down/p' packages/db/migrations/20260914000000_schema_v1_1.sql | sed '$d' | docker exec -i mineral-pg psql -U postgres -v ON_ERROR_STOP=1
```

```bash
docker exec -i mineral-pg psql -U postgres -v ON_ERROR_STOP=1 < packages/db/tests/schema_v1_1.test.sql
```

Expected last line: `ALL SCHEMA TESTS PASSED`.

Without Docker, local PostgreSQL 16 binaries work the same way against a throwaway cluster (verified on Windows, PostgreSQL 16.12):

```bash
"C:/Program Files/PostgreSQL/16/bin/initdb.exe" -D /tmp/mineral-pgdata -U postgres -A trust -E UTF8 --locale=C && "C:/Program Files/PostgreSQL/16/bin/pg_ctl.exe" -D /tmp/mineral-pgdata -o "-p 55432" -w start && "C:/Program Files/PostgreSQL/16/bin/psql.exe" -h localhost -p 55432 -U postgres -c "create database mineral"
```

Then run the migration and test with `psql -h localhost -p 55432 -U postgres -d mineral -v ON_ERROR_STOP=1` in place of `docker exec -i mineral-pg psql -U postgres -v ON_ERROR_STOP=1`.

## Implementation sequence

See `docs/architecture/00-architecture-understanding.md` §J. Next phase: bootstrap (pnpm workspace, TS strict, Vitest, dbmate, Python analytics with uv + pytest).
