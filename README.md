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
| `packages/ingest/` | SEC EDGAR connector, XBRL concept map, content hashing and chunking |
| `packages/db/` | PostgreSQL schema, seeds, SQL invariant tests, SQL-first repositories |
| `services/analytics/` | Python deterministic calculations behind `POST /calc/{method}` |
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
Verified locally: 79 hermetic tests, 100 with a database, and 63 Python tests.

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

## Ingestion

SEC refuses anonymous traffic, so the connector needs a contact in the shape
the SEC documents. A URL is not accepted in place of an address:

```bash
export SEC_USER_AGENT="Your Name your.address@example.com"
```

```bash
pnpm ingest "MP" --forms 10-K,10-Q --limit 2 --since 2019-01-01
```

Filings are stored as immutable document versions addressed by the SHA-256 of
the bytes as fetched. Re-running the same ingest writes nothing: identical
bytes hit the content hash and identical numbers match the current fact
revision. Different bytes add a version rather than replacing one, and a
restated number supersedes its predecessor instead of overwriting it.

XBRL company facts reach the record as promoted `VERIFIED` revisions without
passing through a language model: an explicit `us-gaap` concept map, the
latest-filed value per period, and the filing itself as the cited source. The
epistemic ceiling is the same one claims obey — source tier caps status, so a
tier-1 filing is what makes `VERIFIED` available here at all.

## Analytics

Every formula is a pure function with no network, no database and no model in
the path, so the same inputs give the same number from a test, a script or the
service. `ENGINE_VERSION` is stored with each result; it is bumped whenever a
formula changes, which is what makes a stored number recomputable.

```bash
pnpm analytics
```

```bash
curl -s localhost:8000/calc/dcf -H 'content-type: application/json' -d '{"inputs":{"base_cash_flow":100,"growth_rates":[0.10,0.10],"discount_rate":0.10,"terminal_growth":0.02,"net_debt":275,"shares_outstanding":100}}'
```

Methods: `ratios`, `dcf`, `reverse_dcf`, `pe`, `ev_ebitda`, `ev_sales`,
`fcf_yield`. `GET /methods` reports what each one accepts. An input the method
does not take is refused rather than ignored, and a multiple on a negative
denominator is refused rather than returned, because it would rank the deepest
loss maker as the cheapest stock.

## Calculated facts

```bash
pnpm calc "MP" ratios --period-end 2024-12-31 --period-start 2024-01-01
```

Reads the promoted facts for that period, calculates, and stores each result as
a promoted `CALCULATED` fact linked through `evidence.fact_derivations` to the
revisions it came from, so a ratio can be traced to the filing underneath it.
Facts from different periods are never mixed: durations and instants each have
to agree, and a code that matches twice is reported as ambiguous instead of
guessed. Re-running writes no new revision; it does write a new
`valuation.calculation_runs` row, because a calculation is an event and two
runs with different assumptions both have to stay readable.

## Schema check

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

```bash
for f in packages/db/migrations/*.sql; do sed -n '/-- migrate:up/,/-- migrate:down/p' "$f" | sed '$d'; done | docker exec -i mineral-pg psql -U postgres -v ON_ERROR_STOP=1
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

See `docs/architecture/00-architecture-understanding.md` §J. Phases 0 to 4 are done. Next: phase 5, the LLM gateway with response caching and `model_runs` logging.
