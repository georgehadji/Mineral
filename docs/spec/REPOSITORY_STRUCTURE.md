# Trading Research Platform — Canonical Repository Structure

## Architectural rule
The repository is organized around the product's domain, not around any source repository.

## Top-level

```text
trading-research/
├── apps/
│   ├── web/                         # Next.js application
│   │   ├── app/
│   │   │   ├── (auth)/
│   │   │   ├── dashboard/
│   │   │   ├── companies/
│   │   │   ├── securities/
│   │   │   ├── themes/
│   │   │   ├── supply-chain/
│   │   │   ├── research/
│   │   │   ├── portfolio/
│   │   │   ├── alerts/
│   │   │   └── settings/
│   │   └── src/
│   │       ├── components/
│   │       ├── features/
│   │       ├── hooks/
│   │       └── lib/
│   │
│   └── api/                         # Optional dedicated API later
│
├── packages/
│   ├── domain/                      # Canonical TypeScript domain types
│   ├── db/                          # SQL, migrations, repositories
│   ├── events/                      # Typed event contracts
│   ├── config/                      # Runtime configuration
│   ├── ui/                          # Shared UI primitives
│   └── schemas/                     # Zod/JSON schemas shared by app/workers
│
├── services/
│   ├── research/                    # Research orchestration + modules
│   │   ├── modules/
│   │   │   ├── company-profile/
│   │   │   ├── business-model/
│   │   │   ├── industry-position/
│   │   │   ├── commodity-exposure/
│   │   │   ├── supply-chain-position/
│   │   │   ├── resource-quality/
│   │   │   ├── project-pipeline/
│   │   │   ├── financial-quality/
│   │   │   ├── capital-structure/
│   │   │   ├── management/
│   │   │   ├── competitive-landscape/
│   │   │   ├── valuation/
│   │   │   ├── catalysts/
│   │   │   ├── risks/
│   │   │   ├── bear-case/
│   │   │   ├── scenario-model/
│   │   │   └── verification/
│   │   ├── recipes/
│   │   ├── orchestrator/
│   │   └── prompts/
│   │
│   ├── ingestion/                   # Documents, filings, news, market data
│   │   ├── connectors/
│   │   ├── normalization/
│   │   ├── extraction/
│   │   └── jobs/
│   │
│   ├── analytics/                   # Python deterministic analytics
│   │   ├── valuation/
│   │   ├── financials/
│   │   ├── portfolio/
│   │   ├── risk/
│   │   └── scenarios/
│   │
│   ├── ai/                          # LLM gateway + tool gateway
│   │   ├── providers/
│   │   ├── routing/
│   │   ├── tools/
│   │   ├── policies/
│   │   └── evaluation/
│   │
│   ├── monitoring/                  # Change detection + thesis drift
│   │   ├── detectors/
│   │   ├── thesis-drift/
│   │   └── alerts/
│   │
│   └── ontology/                    # Domain ontology + relationship rules
│       ├── commodities/
│       ├── materials/
│       ├── supply-chain/
│       └── relationships/
│
├── workers/
│   └── inngest/                     # Durable async workflows
│       ├── research/
│       ├── ingestion/
│       ├── monitoring/
│       └── notifications/
│
├── database/
│   ├── migrations/
│   ├── seeds/
│   └── fixtures/
│
├── evals/
│   ├── extraction/
│   ├── citations/
│   ├── numerical/
│   ├── temporal/
│   ├── contradiction/
│   └── thesis/
│
├── docs/
│   ├── architecture/
│   ├── domain/
│   ├── research-methodology/
│   ├── data-providers/
│   └── runbooks/
│
├── infra/
│   ├── docker/
│   ├── terraform/
│   └── observability/
│
└── tests/
    ├── integration/
    ├── contract/
    └── end-to-end/
```

## Dependency direction

```text
apps/web
   ↓
packages/domain + packages/schemas
   ↓
services/*
   ↓
packages/db / external providers

services/analytics is independent and deterministic.
services/ai may consume domain state but may not directly mutate canonical facts.
```

## Hard boundaries

1. `companies`, `securities`, `financial_facts`, and source/document records are canonical state.
2. LLMs can propose candidate facts, claims, assumptions, and interpretations; validation promotes them into canonical state.
3. Deterministic analytics owns calculations.
4. Research modules emit structured JSON, not HTML.
5. Reports are projections of stored research state, not the source of truth.
6. Research runs are immutable after completion; corrections create new versions.
