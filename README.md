# Mineral

Continuous investment-research platform. Turns fragmented financial, corporate, industrial, commodity and geopolitical information into a versioned, evidence-backed investment thesis. First domain: rare earths and permanent-magnet supply chains.

Evidence before prose. Deterministic calculations before LLM conclusions. Versioned research instead of static reports.

## Layout

| Path | Purpose |
|---|---|
| `docs/spec/` | Frozen product and architecture spec (brief, rules, original schema draft, domain types, events, recipe) |
| `docs/architecture/` | Architecture understanding report and layout decisions |
| `docs/domain/` | Domain semantics (time axes, epistemic status, source tiers) |
| `packages/domain/` | Canonical TypeScript types, no runtime dependencies |
| `packages/events/` | Versioned event envelope and payload contracts |
| `packages/schemas/` | Zod mirrors, parsed at every trust boundary |
| `packages/research/` | Module registry, recipes, DAG derivation |
| `packages/identity/` | Identifier normalisation and resolution planning |
| `packages/db/` | PostgreSQL schema, seeds, SQL invariant tests, SQL-first repositories |
| `services/analytics/` | Python deterministic calculations |
| `infra/docker/` | Local PostgreSQL |

## Development

Requires Node 20 or newer with pnpm 9, Python 3.12 with uv, and PostgreSQL 16 or Docker.

```bash
pnpm install && pnpm check
```

```bash
cd services/analytics && uv sync --extra dev && uv run pytest
```

`pnpm check` runs the TypeScript typecheck and the Vitest suite. Database-backed
tests are skipped unless `DATABASE_URL` is set, so the default run is hermetic.
Verified locally: 48 hermetic tests, 57 with a database, and 11 Python tests.

## Entity resolution

Apply the migration, then the issuer seed:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/seeds/001-rare-earth-issuers.sql
```

```bash
pnpm resolve "MP"
```

Resolution walks a ladder from exact registry identifier to name prefix and
reports which strategy matched. A query that matches several companies is
returned as ambiguous rather than resolved to a guess. Every CIK in the seed
comes from the SEC registry file; fields that could not be verified against a
primary source are left null.

## Schema check

```bash
docker compose -f infra/docker/docker-compose.yml up -d
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

See `docs/architecture/00-architecture-understanding.md` §J. Phases 0 and 1 (contracts half) are done. Next: phase 2, identity and entity resolution, seeded with MP Materials.
