# Mineral

Continuous investment-research platform. Turns fragmented financial, corporate, industrial, commodity and geopolitical information into a versioned, evidence-backed investment thesis. First domain: rare earths and permanent-magnet supply chains.

Evidence before prose. Deterministic calculations before LLM conclusions. Versioned research instead of static reports.

## Layout

| Path | Purpose |
|---|---|
| `docs/spec/` | Frozen product and architecture spec (brief, rules, original schema draft, domain types, events, recipe) |
| `docs/architecture/` | Architecture understanding report and layout decisions |
| `docs/domain/` | Domain semantics (time axes, epistemic status, source tiers) |
| `apps/web/` | Next.js app: company page, evidence drill-down, run trigger, Better Auth |
| `packages/domain/` | Canonical TypeScript types, no runtime dependencies |
| `packages/events/` | Versioned event envelope and payload contracts |
| `packages/schemas/` | Zod mirrors, parsed at every trust boundary |
| `packages/research/` | Module registry, recipes, DAG derivation, verification rules, assumption policy |
| `packages/identity/` | Identifier normalisation and resolution planning |
| `packages/ingest/` | SEC EDGAR connector, XBRL concept map, content hashing and chunking |
| `packages/ai/` | Model gateway: OpenRouter adapter, Zod to JSON Schema, tier routing |
| `packages/monitoring/` | Deterministic drift rules: new sources, invalidated assumptions, valuation moves |
| `packages/db/` | PostgreSQL schema, seeds, SQL invariant tests, SQL-first repositories, read models |
| `evals/` | Labelled datasets and the scorer that gates changes to the deterministic layer |
| `services/analytics/` | Python deterministic calculations behind `POST /calc/{method}`, including the concentration indices |
| `infra/docker/` | Local PostgreSQL |

## Development

Requires Node 22.18 or newer with pnpm 9, Python 3.12 with uv, and PostgreSQL 16 or Docker.

```bash
pnpm install && pnpm check
```

```bash
cd services/analytics && uv sync --extra dev && uv run pytest
```

`pnpm check` runs the TypeScript typecheck and the Vitest suite. Database-backed
tests are skipped unless `DATABASE_URL` is set, so the default run is hermetic.
Verified locally: 218 hermetic tests, 285 with a database, and 85 Python tests.

Configuration lives in `.env`, which Git ignores. Copy the example and fill
in what you have:

```bash
cp .env.example .env
```

The CLIs load it themselves (`node --env-file-if-exists=.env`) and dbmate
reads it natively, so a credential never has to be typed at a prompt where
the shell history would keep it. Vitest deliberately does not load it:
database-backed tests stay opt-in per shell, so `pnpm check` is still
hermetic on a machine that happens to have a `DATABASE_URL` in `.env`.

On Windows, one command brings the whole thing up -- the database cluster, the
analytics service and the web app -- starting only what is not already
running, with analytics and web in windows of their own:

```bash
pnpm local
```

It expects a native PostgreSQL 16 cluster at `%USERPROFILE%\mineral-pgdata` on
port 55432 (`scripts/start-local.ps1 -DataDir ... -Port ...` to point it
elsewhere). Nothing here is a Windows service, so this is also what to run
after a reboot; a cluster killed by a logoff recovers on its own.

## Entity resolution

Apply the migration, then the issuer seed:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/seeds/001-rare-earth-issuers.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/seeds/002-supply-chain-ontology.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/seeds/003-facilities.sql
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
the SEC documents. A URL is not accepted in place of an address. In `.env`:

```
SEC_USER_AGENT=Your Name your.address@example.com
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

## Model gateway

Every model call goes through OpenRouter, is logged to `research.model_runs`,
and has its response stored in `research.model_cache` under a hash of the
request. Temperature is 0 and structured output comes from a forced tool call,
not from parsing prose, so the same request has one answer. The key goes in
`.env`, and nothing else in the repo needs it:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

```bash
pnpm ask "What does MP Materials mine?"
```

Run it twice. The first call reaches the provider; the second reports `cached`,
costs nothing, and never opens a socket. A replay needs no API key at all,
which is what makes a recorded run reproducible on a machine with no
credentials. The request hash covers the model, system prompt, user prompt,
response schema, temperature and token limit, so anything that could change
the answer misses the cache, and nothing else does.

Routing sends mechanical work to the cheap tier and judgement to the strong
one: extraction and classification to `anthropic/claude-haiku-4.5`, synthesis
and verification to `anthropic/claude-opus-5`. Change `ROUTING` in
`packages/ai/src/gateway.ts` to move a tier, and
`provider.require_parameters` keeps a request away from any upstream endpoint
that would drop the tool definition and answer in prose instead.

Cost is not estimated. OpenRouter reports what each call was charged and that
number is stored, so there is no price table to keep current; a call the
provider does not cost records null rather than a guess. Set
`OPENROUTER_SITE_URL` to attribute calls on the OpenRouter dashboard, or leave
it unset and no referrer is sent.

Nothing here writes canonical state. A model proposes; promotion happens
elsewhere, under the rules in `docs/domain/`.

## Research runs

A run takes a recipe, freezes what the subject's evidence looks like right now,
and walks the module DAG against that frozen set.

```bash
pnpm research "MP"
```

Modules are pure: each receives a context and returns claims, and none of them
touches the database. Persistence, and the citation check, live in
`packages/db/src/research-repository.ts`. Nothing a module returns is written
until every quote has been found in the chunk it cites and every cited id has
been found inside the snapshot -- a claim with a fabricated quote fails its
module, and a failed required module fails the run.

A module may assert DERIVED, INFERRED, HYPOTHESIS or UNKNOWN. VERIFIED and
CALCULATED are not in its vocabulary: the validator assigns the first and the
analytics engine the second. UNKNOWN with no evidence is a real answer and is
accepted as one; anything else with no evidence is rejected.

Runs are keyed by subject, recipe version, date and snapshot hash, so asking
twice for the same thing returns the first run rather than writing a second. A
run against a subject with no ingested evidence is refused outright, because an
empty snapshot produces confident UNKNOWNs that read like findings.

`pnpm research` runs `CORE_RECIPE`, the cheap path: seven modules, enough to
reach a valuation. `DEEP_RECIPE` adds industry position, supply-chain position,
project pipeline, management, competitive landscape, risks, catalysts and the
bear case, fifteen modules in all. The bear case runs last and argues against
the proposed valuation inputs rather than the computed total, because an input
is what the total is made of and is the more checkable thing to dispute.

## Verification

A separate deterministic pass over what a run wrote.

```bash
pnpm verify "MP"
```

Four rules, none of which consults a model: a quote must appear in the chunk it
cites, every number in a statement must appear in the evidence that statement
cites, a financial claim may not rest only on a tier 4 or 5 source, and two
claims sharing a `claim_key` must not say different things. Each rule writes a
`research.verification_checks` row whether it passes or fails, so a later reader
can see what was checked rather than inferring it from silence.

The rules only work together. A fabricated quote can perfectly well contain the
fabricated number that cites it, so the number rule alone would pass it;
containment is what anchors the quote to a document. A claim that fails a check
at error or critical severity becomes `CONTRADICTED`, and the status event
records which check did it.

This repeats work the module runtime already does at write time, on purpose. A
check that only runs on the way in cannot catch a row that arrived another way,
and cannot be re-run in a year against a claim whose source has since changed.

## Decisions

What a completed run is for. Four steps, in order, over stored rows:

```bash
pnpm decide "MP"
```

**Policy.** A module proposes assumptions at status `proposed`; a deterministic
rule in `packages/research/src/decision.ts` approves or refuses each one. A
value outside its band, outside the range the proposal itself stated, without a
rationale, or resting on a claim verification has thrown out is refused. A
terminal growth at or above the discount rate is refused as a set, because the
Gordon terminal value would be infinite or negative. Approval is recorded as
`approved_by = 'policy'`: the model that proposed the number never approves it.

**Scenario.** The approved revisions, held together under one name. A database
trigger refuses to put a version in a scenario unless it is already approved,
and the table allows one version per assumption, so a scenario cannot quietly
hold two answers to the same question.

**Valuation.** One DCF through the Python engine, recorded as a
`valuation.calculation_runs` row that names the research run, the scenario, the
promoted fact revisions and the approved assumption revisions it consumed. The
outputs come back as `CALCULATED` facts with derivation edges to their inputs.
Without a full approved set there is no valuation, and the thesis says so.

**Synthesis.** One model call turns findings, approved assumptions and the
valuation into a thesis version with nodes and edges. Every node that asserts
something names the claim, approved assumption or calculation it rests on, and
every name is resolved against what the run actually produced before anything is
written -- a node citing a finding nobody made fails the decision. A run that
left no evidenced finding standing produces no thesis at all.

Deciding the same run twice returns the thesis already written. Note that
deciding promotes calculated facts, which belong in the next snapshot: asking
for a research run "as of" the same date afterwards correctly yields a new run,
because the evidence is no longer the same evidence.

## Web

```bash
pnpm web
```

Then http://localhost:3000. It reads the repository's `.env` like the CLIs do,
so `DATABASE_URL` is enough to look around; model calls additionally need
`OPENROUTER_API_KEY`, and a valuation needs `pnpm analytics` running.

The pages are read models and nothing else (invariant C.9). Every figure is read
back from the row that recorded it: `packages/db/src/read-repository.ts` holds
the queries, it never writes, and it computes no number that is not already
stored. A page can be stale. It cannot disagree with the record.

**The company page** shows the latest thesis version -- verdict, confidence,
summary -- then its nodes grouped by type, the valuation with the range it has
taken across scenarios, the assumptions behind it with the ones policy refused
still visible, the evidence counts, and what changed since the previous thesis
version. The diff is derived on read from two immutable versions rather than
stored, and nodes are matched across versions by `claim_key` or assumption code,
so a claim restated by a later run is recognised as the same subject rather than
reported as new.

**The drill-down** is the point. Every node names what it rests on, and the name
is a link: a claim goes to its statement, its citations, its verification checks
and the other runs that answered the same `claim_key`; each citation goes to the
stored filing with the cited chunk highlighted. A valuation input takes the
other route -- a promoted fact revision names the document version it was read
off, so a number reaches its filing without a claim in between.

**Starting a run** needs an account; reading does not. Better Auth is configured
for email and password only, in its own prefixed tables, because the one thing a
passer-by must not be able to do is spend money on model calls. The trigger runs
research, then verification, then the decision, and returns as soon as the run
row exists so the status page has something to show.

On one machine there is no passer-by, so `MINERAL_LOCAL_OPERATOR` disconnects
the sign-in rather than removing it: set it to an address and the app skips the
session, attributes runs to that person's `core.users` row, and sends
`/sign-in` back to the index. Unset it and Better Auth guards the trigger
again, unchanged. It is opt-in for the obvious reason -- an environment that
never sets it is closed, and a host anyone can reach must not set it.

## Supply chain

```bash
pnpm chain ndpr_oxide
```

```bash
pnpm chain ndpr_oxide --measure
```

A company is one position in a chain. Seed 002 lays the first one down: nine
stages from mining to recycling, the materials that sit at each, the elements
they carry, and `SUPPLIES` edges between them, so asking about separated oxide
reaches both the mine and the motor.

The seed carries no quantity. Stages and flows are definitions of the chain;
who produces how much is measurement, and measurement arrives as a promoted
fact with a filing under it. `recordProduction` is the entry point, and it
demands a source document version rather than accepting a null one.

`--measure` sends the measured quantities to the analytics engine and stores
what comes back as a calculation run, with one `calculation_run_inputs` row per
producer revision. The page at `/supply-chain/ndpr_oxide` reads the index back
from that run; it never computes one (invariant C.9). A stage nobody has
measured shows a gap, because a bottleneck is the easiest claim in this domain
to assert and the hardest to support.

## Monitoring

```bash
pnpm monitor "MP"
```

A thesis is a statement made at one moment from one set of documents, and the
world then carries on. Monitoring is the deterministic answer to whether that
statement still rests on what it rested on. It reads the latest thesis version
and reports three things: primary sources that arrived after the run behind it
started reading, thesis nodes whose evidence has moved underneath them, and how
far the valuation has travelled from the one the thesis was written against.

Each finding is matched against the enabled rules on that company and recorded
in `monitoring.alert_events` with a reference to the row that caused it -- the
new document version, the promoted fact revision, the later calculation run --
so an alert is a pointer into the record rather than a sentence about it.

`packages/monitoring/src/drift.ts` holds the rules as pure functions; nothing in
them writes, and nothing recomputes a number. The valuation rule compares two
stored calculation runs rather than running the engine again, because a watch
that recalculates its own evidence is a second opinion.

Running it twice is free. Every alert carries a dedupe key that is a function of
its cause and the schema holds that column unique, so the same drift reported
again writes nothing.

Rules belong to a user: `pnpm monitor` creates the three default rules for the
only account if there is one, and wants `--user <email>` otherwise.

## Evals

```bash
pnpm eval
```

Two labelled datasets and a scorer. `evals/datasets/verification-v1.json` gives
the verification rules cases whose right answer is known; `extraction-v1.json`
gives the XBRL concept map synthetic companyfacts and the figures it should
read back. Both report accuracy, precision and recall per rule.

Roughly half of every rule's cases are clean. A rule measured only on cases it
should fail proves nothing about false positives, and a rule that fires on
everything is as useless as one that never fires. Precision says how often a
reported failure is real; recall says how much of what is wrong it finds.

This is the gate. Each dataset carries the accuracy its target has to reach and
a run below it exits non-zero, so a change to a verification rule or to the
concept map cannot land while it makes either worse. CI runs it with no database
and no model key, which is what lets it run on every pull request. Scores are
stored in `research.evaluation_runs` when `DATABASE_URL` happens to be set.

It earned itself on the first run: the contradiction rule emitted a check only
when it fired, so a clean run and a run where the rule never executed looked
identical in the stored checks. It now records a verdict for every claim.

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

See `docs/architecture/00-architecture-understanding.md` §J. Phases 0 to 12 are done, which is the end of the sequence the report lays out.
