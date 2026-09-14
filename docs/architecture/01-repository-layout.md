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
├── packages/
│   ├── domain/      # types only, no runtime dependencies
│   ├── events/      # event contracts, versioned envelope
│   ├── schemas/     # Zod mirrors, parsed at trust boundaries
│   ├── research/    # module registry, recipes, DAG derivation
│   └── db/          # migrations and SQL invariant tests
├── services/
│   └── analytics/   # Python, deterministic calculations
├── infra/docker/    # local PostgreSQL
├── docs/
│   ├── spec/        # frozen inputs
│   ├── architecture/
│   └── domain/      # time axes, epistemic status, source tiers
└── .github/workflows/
```

Planned, created when first used: `apps/web`, `packages/{ingestion, ai, monitoring, ontology, config, ui}`, `evals/`.

## Dependency direction

```text
apps/web
   ↓
research · ingestion · ai · monitoring
   ↓
domain · schemas · events · db
```

`domain` imports nothing. `schemas` imports `domain` and `events`. `research`
imports `domain`. Enforcement today is the absence of the reverse edges plus
`pnpm typecheck`; add eslint import boundaries when `apps/web` lands, because
that is the first point where the rule can actually be broken by accident.

## Package entry points

Packages export TypeScript source directly (`"exports": "./src/index.ts"`) and
are consumed through the workspace. There is no build step in V1: Vitest and
Next.js both compile TypeScript, and a build step would only add a stale-output
failure mode. Add one when something outside the monorepo consumes a package.
