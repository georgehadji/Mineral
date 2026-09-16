# Repository layout

Decision record for report items I.26 to I.28. Supersedes `docs/spec/REPOSITORY_STRUCTURE.md`
where the two disagree; the spec copy stays frozen as the original input.

## Rules

1. **One home per concern.** The spec had `packages/db` and `database/`, and both
   `evals/` and `services/ai/evaluation`. Kept: `packages/db` and a top-level
   `evals/`. (I.26)
2. **Create a directory when something goes in it.** `apps/api`,
   `infra/terraform` and a separate `workers/` tree were premature: V1 serves
   Inngest functions from a Next.js route, so there is no second deployable to
   justify them. (I.27)
3. **Dependencies point inward.** `apps/web` depends on feature packages, which
   depend on `domain`, `schemas` and `db`. Nothing inward depends on anything
   outward. The spec diagram had this inverted. (I.28)
4. **Directories are kebab-case, persisted codes are snake_case.** A module
   lives in `modules/company-profile/` and is stored as `company_profile`. (I.25)

## Current tree

```text
mineral/
├── apps/
│   └── web/         # Next.js App Router: company page, drill-down, run trigger, Better Auth
├── packages/
│   ├── domain/      # types only, no runtime dependencies
│   ├── events/      # event contracts, versioned envelope
│   ├── schemas/     # Zod mirrors, parsed at trust boundaries
│   ├── research/    # module registry, recipes, DAG derivation
│   ├── identity/    # identifier normalisation, resolution planning
│   ├── ingest/      # SEC EDGAR connector, XBRL concept map, hashing, chunking
│   ├── ai/          # model gateway: OpenRouter adapter, schema conversion, routing
│   ├── monitoring/  # deterministic drift rules over a stored thesis
│   └── db/          # migrations, seeds, SQL invariant tests, repositories
├── services/
│   └── analytics/   # Python: ratios, DCF, multiples; FastAPI POST /calc/{method}
├── infra/docker/    # local PostgreSQL
├── docs/
│   ├── spec/        # frozen inputs
│   ├── architecture/
│   └── domain/      # time axes, epistemic status, source tiers
├── tests/           # repo-level rules that belong to no single package
└── .github/workflows/
```

Planned, created when first used: `packages/{ontology, config, ui}`, `evals/`.
`packages/monitoring` arrived at J.10, under rule 2: the alert tables existed from
schema v1.1, but nothing evaluated them until there was a thesis to drift from.
The spec called the ingestion package `ingestion`; it landed as `ingest` to match the verb used everywhere else (`pnpm ingest`).

Rule 2 said `apps/web` was premature because V1 would serve Inngest functions
from a Next.js route and there was no second deployable to justify the tree.
That reason is now void -- phase J.6 replaced Inngest with an injected `Step`
seam -- but the directory arrived anyway at J.9, for the app itself rather than
for the worker it was once going to host.

## Dependency direction

```text
apps/web
   ↓
research · ingest · ai · monitoring
   ↓
domain · schemas · events · db
```

`domain` imports nothing. `schemas` imports `domain` and `events`. `research`
and `identity` import `domain`. `ingest` imports nothing and speaks HTTP to
one provider; the `db` repositories are the only place where ingestion results
meet SQL. `services/analytics` is reached over HTTP and depends on nothing in
the workspace, which is what keeps every formula runnable from a test, a
script or the service and gives the same answer each time. `ai` imports only
`zod` and writes no SQL at all: it prepares, sends and parses a model call, and
the `db` repository decides whether to send one and records what happened.
`monitoring` imports `domain` and nothing else: it holds the drift rules as pure
functions, and the `db` repository loads the rows they read and writes the alerts
they produce. `apps/web` reads through `db` and `research` and is depended on by
nothing.

Enforcement is `tests/dependency-direction.test.ts`, which places every
workspace package in a ring and fails if one declares a dependency further out.
This replaces the eslint import boundary this document promised for the arrival
of `apps/web`: pnpm links strictly, so a package can only import what its own
`package.json` declares, which makes the declared graph the import graph. A lint
rule would re-derive the same fact with a toolchain the repository does not
otherwise need.

## Package entry points

Packages export TypeScript source directly (`"exports": "./src/index.ts"`) and
are consumed through the workspace. There is no build step in V1: Vitest and
Next.js both compile TypeScript, and a build step would only add a stale-output
failure mode. Add one when something outside the monorepo consumes a package.
