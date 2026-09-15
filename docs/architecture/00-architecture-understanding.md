# Architecture Understanding Report — Mineral (Investment Research OS)

Date: 2026-09-14. Inputs: project brief, `IMPLEMENTATION_RULES.md`, `REPOSITORY_STRUCTURE.md`, `V1_SCHEMA.sql`, `domain.ts`, `events.ts`, `company-deep-research.yaml` (now under `docs/spec/`). Per brief §32 this report preceded any code. Status: schema fixes I.1–I.16 are implemented in `packages/db/migrations/20260914000000_schema_v1_1.sql` and verified by `packages/db/tests/schema_v1_1.test.sql`. Contract fixes I.17–I.25 are implemented in `packages/domain`, `packages/events`, `packages/schemas` and `packages/research`, verified by `pnpm test`. Layout decisions I.26–I.28 are recorded in `01-repository-layout.md`; the import-boundary lint of I.28 is deferred until `apps/web` exists. The three rule change proposals below remain proposals awaiting a decision, except that the rule 7 extension is already enforced in `packages/schemas`. Phase J.2 (identity) is implemented: `packages/identity`, `packages/db` repositories, and seed 001 with six rare-earth issuers. Phase J.3 (ingestion) is implemented: `packages/ingest` holds the EDGAR connector and the `us-gaap` concept map, `packages/db/src/ingest-repository.ts` writes immutable content-hashed document versions and promotes XBRL values with no model in the path, and migration `20260915000000_source_registry_unique.sql` adds the source-name uniqueness the upsert needs. The live SEC fetch is unverified: SEC returns 403 unless `SEC_USER_AGENT` carries a real contact address, which is the operator's to supply. Phase J.4 (analytics) is implemented: `services/analytics` holds pure ratio, DCF, reverse-DCF and multiples functions behind a registry and a FastAPI `POST /calc/{method}`, and `packages/db/src/calc-repository.ts` stores each invocation as a `valuation.calculation_runs` row and each result as a promoted `CALCULATED` fact linked through `evidence.fact_derivations` to the revisions it was computed from. Two decisions are worth recording. `factEpistemicStatus` no longer requires a source tier: a calculated value has no source of its own, its inputs carry the tiers, and demanding one invited a fabricated number; a value read off a source with no tier now throws instead. And a calculation is stored as an event, not a registry entry, so re-running writes a new run row while writing no new fact revision.

---

## A. System understanding

We build a system that maintains a **versioned, evidence-backed investment thesis per subject** (company first) and keeps it current as new evidence arrives. Not a stock page. Not a chat summarizer. Not a terminal.

Core asset is structured knowledge, not UI: `source → document → document version → fact → fact version → claim → claim evidence → analysis → assumption → valuation → thesis node`. Every node traceable, stamped on several time axes, labeled with epistemic status.

Product loop: question → recipe → data → evidence → facts → claims → analysis (independent perspectives) → disagreement → verification → thesis → assumptions → deterministic valuation → scenarios → decision → monitoring → drift → new thesis version.

Three non-negotiables: evidence before prose; deterministic math before LLM conclusions; versioned state instead of static reports.

First domain: rare earths → critical minerals → permanent magnets → industrial supply chains. Chosen because value lives in relationships (element → material → stage → facility → company → customer → end market) and bottlenecks, which screening cannot see.

V1 success = one company end to end: search → resolve → ingest → facts → claims → modules → verify → value → thesis → display → persisted reproducible run.

---

## B. Architecture reconstruction

Five engines, mapped to the artifacts:

| Engine | Tables (`V1_SCHEMA.sql`) | Code (`REPOSITORY_STRUCTURE.md`) | Events (`events.ts`) |
|---|---|---|---|
| Data | `core.*`, `market.*`, `research.sources/documents/document_versions/document_chunks` | `services/ingestion` | `filing.ingested`, `company.updated` |
| Evidence | `research.fact_definitions/facts/fact_versions/claims/claim_evidence` | `services/ingestion/extraction`, `packages/domain` | `evidence.created` |
| Analysis | `research.module_definitions/recipes/runs/module_runs/prompt_versions/model_runs/evaluation_runs` | `services/research` (modules, orchestrator, prompts), `services/ai` | `research.run.requested`, `research.module.requested/completed` |
| Decision | `valuation.*`, `research.thesis_versions/nodes/edges`, `research.verification_runs/checks` | `services/analytics` (Python), `services/research/modules/{valuation,scenario-model,verification}` | `research.verification.requested`, `valuation.changed`, `thesis.updated` |
| Monitoring | `monitoring.*`, `portfolio.*` | `services/monitoring` | `intelligence.alert.triggered` |

Stack: Next.js app (UI + BFF + Inngest serve route), TS packages (`domain`, `schemas`, `db`, `events`), Python analytics service, PostgreSQL + pgvector, Redis, object storage, LLM gateway with provider adapters, OpenTelemetry, Vitest / pytest / eval datasets.

Designed runtime flow:

1. UI emits `research.run.requested`.
2. Orchestrator inserts `research.runs` with `input_snapshot`, loads recipe JSON, topologically sorts modules.
3. Per module: insert `module_runs`, build `ResearchContext`, call `module.run` (LLM via gateway, logged to `model_runs`), `module.validate`, persist output + claims + evidence + proposed assumptions.
4. Verification modules (`contradiction-check`, `numerical-check`, `source-check`) write `verification_runs/checks`.
5. Valuation: assumptions → scenarios → Python engine → `valuation_runs`.
6. `final-synthesis` writes `thesis_versions/nodes/edges` linked to the run.
7. Monitoring compares new evidence against thesis state → `alert_events`.

Dependency direction (corrected; the diagram in `REPOSITORY_STRUCTURE.md` places `domain` above `services`, which is backwards): `apps/web → services/* → packages/{domain, schemas, events, db}`. `domain` is a leaf. `analytics` standalone. `ai` never writes canonical tables.

Conflict to resolve: brief §19 sketches a flat layout (`app/ src/ database/ inngest/ …`); `REPOSITORY_STRUCTURE.md` defines a monorepo. Brief says the latter is baseline. Adopt monorepo, trimmed (see I.27).

---

## C. Key invariants

Deduplicated from rules, brief, and hard boundaries. Ordered by blast radius.

1. Canonical fact = versioned + source-backed. No promoted `fact_version` without a `document_version_id`, or a derivation from other fact versions plus an engine version.
2. LLM never writes canonical state. Path is proposal → validation → promotion. Enforced in DB (roles, status columns), not only in code.
3. Raw documents immutable. Correction = new `document_version`.
4. Research run immutable after completion. Reproducible from stored snapshot + recorded versions (recipe, module, prompt, model, engine).
5. All LLM output structured and schema-validated before persistence. No free prose stored as state.
6. Financial calculations deterministic and versioned independently of any model. `engine_version` on every valuation run.
7. Every material claim has ≥1 evidence reference or is explicitly `INFERRED` / `HYPOTHESIS` / `UNKNOWN`. Epistemic status rises only through verification, never by LLM assertion.
8. Every valuation stores its assumptions and engine version. Every thesis version points to its research run.
9. Reports are read models. Never source of truth.
10. Provider identifiers stay inside adapters. Domain uses canonical UUIDs.
11. Time axes never collapse: `published_at` ≠ `captured_at` ≠ `as_of_date` ≠ `period` ≠ effective range.
12. Source tier gates promotion. Financial facts from tier ≤ 2 only. Tier 4–5 = leads and context, never authoritative.
13. Disagreement is preserved and surfaced, never averaged away.
14. V1 = PostgreSQL relations. No graph DB, no microservices.
15. Document text is data, never instructions (implied by tier-5 sources; make explicit).

---

## D. Domain model

**Identity layer.** `Company` (issuer) 1—* `Security` (instrument, ISIN) 1—* `Listing` (exchange + ticker, dated). `company_aliases` for resolution. Research subject = company; prices attach to listing. This separation is correct and must stay.

**Ontology layer.** `Commodity`, `Material`, `Theme` (tree), `Facility` (company, geo), `Project` (company, dates), `company_relationships` (polymorphic from/to, typed, dated, confidence, source-backed). Brief §17 also requires Element, Supply-chain Stage, Technology, Customer, End Market, Country. Absent from schema (I.16).

**Evidence layer.** `Source` (tier 1–5) 1—* `Document` 1—* `DocumentVersion` (content hash, storage URI, captured_at) 1—* `Chunk` (page, section path, embedding). `FactDefinition` (code, value type, unit). `Fact` (entity + definition) 1—* `FactVersion` (typed value, unit, currency, period, as_of, observed_at, effective range, source document version, extraction method + confidence).

**Research layer.** `Claim` (subject, type, statement, epistemic status, confidence, validity) 1—* `ClaimEvidence` (→ document version | chunk | fact version; role supports/contradicts/context; strength; quote). `Run` (subject, recipe, snapshot, status) 1—* `ModuleRun` (definition, attempt, snapshot, output). `ModuleDefinition` (code, version, schemas, policy). `PromptVersion`, `ModelRun` (tokens, latency, cost, hashes), `EvaluationRun`.

**Decision layer.** `Assumption` (subject, code) 1—* `AssumptionVersion` (value or range, source claim, status proposed → approved). `Scenario` *—* `AssumptionVersion`. `ValuationRun` (scenario, method, engine version, input snapshot, output). `ThesisVersion` (subject, verdict, confidence, run) 1—* `ThesisNode` (DRIVER / ASSUMPTION / RISK / CATALYST / CONCLUSION / UNKNOWN → claim | assumption version). `ThesisEdge` (SUPPORTS / CONTRADICTS / DEPENDS_ON / CAUSES / DERIVED_FROM / INVALIDATES). `VerificationRun` 1—* `VerificationCheck`.

**Monitoring layer.** `AlertRule` (user, entity, type, config) 1—* `AlertEvent`. `Watchlist`, `Portfolio`, `Position` per user.

Semantics that matter:

- Fact = observation ("revenue FY2024 = X"). Claim = interpretation ("revenue growth accelerating"). Claims cite facts and documents. Assumptions are forward-looking and cite claims. Thesis nodes cite claims or assumption versions.
- Research state is global (shared across users). User-owned: watchlists, portfolios, alert rules. Make this explicit; it drives auth and caching.

---

## E. Data flow

Trace: "MP Materials NdPr oxide production, 2024".

1. **Ingestion.** EDGAR connector fetches the 10-K. `sources` (SEC, tier 1) → `documents` (external_id = accession number, `published_at` = filing date) → `document_versions` v1 (content hash, storage URI, raw text, `captured_at`) → `document_chunks` (page, section path). Emit `filing.ingested`.
2. **Extraction.** (a) XBRL companion data → financial facts (revenue, capex, cash) as promoted `fact_versions`, `extraction_method = 'xbrl'`, `VERIFIED`, no LLM. (b) LLM extraction over chunks for non-XBRL facts (production tonnes, capacity with basis = nameplate/operating) → *candidate* fact version → validator: unit parse, verbatim quote exists in cited chunk, source tier, range sanity → promoted → `facts.current_version_id` updated. `period_start/period_end` = CY2024; `observed_at` = capture time.
3. **Run requested.** Subject = company, recipe `company-deep-research@1.0.0`, `as_of_date` = today. Snapshot freezes: document version ids, fact version ids, relationships, market observations, module/prompt/model versions.
4. **Modules.** `entity-resolution` confirms subject. `company-profile` → `business-model` → `commodity-exposure` reads production facts + chunks, emits claim "MP produced ~X t NdPr oxide in 2024, ramping separation", status `DERIVED`, evidence: fact version (supports, 0.9) + chunk (supports). Zod-validated, persisted with run id and module run id.
5. **Financial quality.** Reads XBRL facts; calls analytics engine for margins and growth → `CALCULATED` fact versions with derivation links; emits claims.
6. **Valuation.** LLM proposes assumptions (NdPr price path, utilization, capex) as `proposed` assumption versions with `source_claim_id`. Policy validates ranges and tiers. Approved set → scenarios (base/bull/bear) → Python DCF `engine_version 1.0.0` → `valuation_runs` with input snapshot + output.
7. **Verification.** Quote containment, numbers-vs-facts, tier coverage, contradiction search across claims → `verification_checks`. Contradicted claims get status events. Run summary stored.
8. **Synthesis.** `thesis_versions` vN: DRIVER("scarce ex-China separation capacity" → claim), ASSUMPTION(NdPr price → assumption version), RISK, CATALYST, CONCLUSION(bullish, 0.72). Edges SUPPORTS / DEPENDS_ON. `research_run_id` set. Emit `thesis.updated`.
9. **Read model.** Company page projects thesis, confidence, assumptions, valuation range, evidence counts, diff vs vN-1.
10. **Monitoring.** New 10-Q ingested → facts change → affected claims via `claim_evidence` → affected thesis nodes → drift alert → incremental re-run.

Provenance query paths: number → fact version → document version (+chunk, page) → document (`published_at`) → source (tier). Dependents: fact version → claim evidence → claims → thesis nodes; assumption version `.source_claim_id` → scenarios → valuation runs → thesis nodes (last link missing today, see I.4).

---

## F. Research execution model

Three objects:

- **ResearchModule** (definition): versioned unit. id, version, category, `requires`, input/output Zod schemas, prompt version, policy (model tier, retries, required evidence tiers), `run()`, `validate()`. Pure with respect to persistence: receives `ResearchContext`, returns `ResearchModuleOutput`. Never touches DB.
- **ResearchRun**: one execution of a recipe against a subject at an `as_of_date`. Owns snapshot, status, module runs, verification, resulting thesis version. Immutable once completed.
- **ResearchTask** (= `research.module_runs`): one attempt of one module inside one run. Own input snapshot (context actually given), output, status, attempt counter, errors, linked model runs.

Interaction, on Inngest:

1. `research.run.requested` → orchestrator function. Step: create run (idempotency key = subject + recipe version + as_of + snapshot hash). Step: freeze snapshot.
2. Topo-sort recipe DAG, group into levels. Per level: `Promise.all(step.run(module))`. Each step: build context = snapshot + outputs of declared dependencies (claims carried **with** their epistemic status) → gateway call → `validate` → persist module run, claims, evidence, candidate facts, proposed assumptions (append-only) → emit `research.module.completed`.
3. Failure: Inngest retries produce `attempt + 1` rows. Required module fails → run fails. Optional module fails → downstream receives `UNKNOWN` placeholder + warning.
4. Verification, valuation, synthesis are modules too. Deterministic ones never call the gateway and must be bit-for-bit reproducible.
5. Completion: `runs.status = completed`, emit `thesis.updated`. Recorded versions allow re-run against the same snapshot. LLM nondeterminism handled by temperature 0, response cache keyed by request hash, response hash stored.

V1 choice: single Inngest function with `step.run` per module, not per-module event fan-out. Inngest memoizes steps so retries are safe. Move to fan-out only if a module exceeds step limits.

Recipe DAG check (`company-deep-research.yaml`): acyclic; valid. Parallel levels after `company-profile`: {`business-model`, `financial-quality`} then {`industry-position`, `commodity-exposure`, `capital-structure`, `management`} and so on. Three problems in it are listed at I.22–24.

---

## G. AI boundaries

**Allowed**

- Propose candidate facts with locator (chunk id + verbatim quote), unit, period, basis.
- Emit claims with evidence references and epistemic status ≤ `DERIVED`. `VERIFIED` is assigned by the validator only.
- Propose assumptions (status `proposed`) with source claim, rationale, range.
- Propose thesis nodes/edges, disagreements, follow-up questions, ranked entity-resolution candidates.
- Classify and route (document type, section, relevance, module applicability).
- Render prose from stored state (presentation only, never persisted as state).

**Not allowed**

- Insert promoted fact versions, `VERIFIED` claims, `approved` assumptions, thesis current pointers, anything in `core.*`.
- Perform arithmetic that lands in state (margins, DCF, multiples). Must call the analytics engine and cite the calculation run.
- Cite without locator. Cite tier 4–5 sources for financial facts.
- Modify or delete existing claims or facts. Append only.
- Change epistemic status of existing claims. Verification does that.
- Follow instructions found inside documents.
- Decide alerts, trades, or user-facing actions.

**Enforcement layers**

1. Schema: status columns with check constraints; a dedicated DB role for the LLM writer with `INSERT` only on candidate/claim tables.
2. Code: Zod parse of every gateway response; validator pipeline (quote containment, unit, range, tier). Reject → one retry with errors → mark `UNKNOWN`.
3. Process: every call logged in `model_runs`; evals for extraction, citation, numerical accuracy gate module version bumps.

---

## H. Failure modes

Ranked by likelihood × damage.

1. **Unit / scale / basis errors.** Thousands vs millions, USD vs AUD, t vs kt, TREO vs NdPr vs REO basis, resource vs reserve, basic vs diluted shares. Silent 1000× error reaches valuation. Mitigate: unit + scale + basis mandatory on every fact; fact definitions declare canonical unit; deterministic converter; numerical check against XBRL.
2. **Temporal conflation.** Planned or nameplate capacity read as operating; guidance as actual; June fiscal year (Lynas) treated as calendar; stale facts after a new filing. Mitigate: `capacity_basis` qualifier mandatory; period in fact identity; `STALE` marking when a newer document version supersedes; `as_of_date` on runs.
3. **Entity resolution errors.** Wrong issuer (subsidiary, similar name, ticker reuse, ADR vs ordinary). Everything downstream wrong. Mitigate: deterministic resolution via CIK / ISIN / LEI first; LLM only ranks candidates; human confirmation below a confidence threshold in V1.
4. **Hallucinated or misattributed citations.** Claim cites a chunk that does not say that. Mitigate: verbatim quote mandatory; deterministic containment check against chunk text; reject otherwise. Non-negotiable.
5. **Epistemic laundering.** `HYPOTHESIS` claims consumed by later modules as fact; proposed assumptions used before approval. Mitigate: context carries status; validator forbids claim status above strongest evidence status; synthesis weights by status; assumptions must be approved before valuation.
6. **Circular or duplicated evidence.** Five outlets quoting one press release counted as five sources; claim citing another LLM claim. Mitigate: evidence must be document or fact, never claim; dedupe by content hash + canonical URL; source check counts distinct tier-1/2 origins.
7. **Deterministic engine bugs.** Wrong terminal value, net debt, share count, FX date. Reproducible but wrong. Mitigate: golden tests against hand-computed cases; engine version bump discipline; numerical check recomputes key ratios independently.
8. **Non-reproducibility.** Context built by live query at run time instead of from snapshot; model deprecated; prompt edited in place. Mitigate: content-addressed snapshot; immutable prompt versions; response cache.
9. **Retrieval bias and PDF parsing.** Tables mangled, numbers lost, only narrative retrieved. Mitigate: XBRL for financials; table-aware parsing; retrieval evals.
10. **Verification theater.** Same model verifying its own output on the same context. Mitigate: deterministic checks first; different model and prompt for judgment checks; adversarial bear-case module.
11. **Prompt injection via tier 4–5 sources.** Mitigate: tier gating; documents passed as data; no tool calls driven by document text.
12. **Fake confidence.** Uncalibrated 0.85s aggregated into "72 / 100". Mitigate: confidence computed by rule (evidence tier, count, verification status), not LLM self-report; calibrate via evals.
13. **Concurrency.** Two runs promote conflicting versions; `version_no` races; current pointer wrong. Mitigate: promotion through one SQL function with row lock; exclusion constraints.
14. **Drift noise.** Reworded claim on re-run detected as change. Mitigate: stable `claim_key`; diff structured fields (value, status, evidence set), not text.
15. **Market data errors.** Unadjusted splits, wrong currency, wrong listing. Mitigate: `adjusted_close` + provider recorded; listing currency validated.

---

## I. Architectural weaknesses

### Schema (`V1_SCHEMA.sql`) — fix before first migration

1. **Fact identity conflates period with revision.** `facts unique(entity_type, entity_id, fact_definition_id)` yields one "revenue" fact per company; FY2023, FY2024 and restated FY2024 all become "versions". `current_version_id` becomes meaningless. Fix: fact identity = `(entity_type, entity_id, fact_definition_id, period_start, period_end, as_of_date, qualifiers_hash)`; `fact_versions` = revisions only, with `supersedes_version_id` and `status`. `qualifiers jsonb` carries basis, product, facility.
2. **Rule 5 unenforceable.** No candidate state anywhere. Add `fact_versions.status in ('candidate','promoted','rejected','superseded')`, `proposed_by_model_run_id`, `promoted_by in ('validator','user')`, `promoted_at`. `facts.current_version_id` may only reference a promoted row (trigger).
3. **Nine polymorphic `(entity_type, entity_id)` pairs with zero FKs.** Add `core.entities(id pk, entity_type)` supertype; `companies`, `securities`, `projects`, `facilities`, `commodities`, `materials`, `themes` take their id from it; every polymorphic `entity_id` FKs to `core.entities`. Add `ontology.countries` (domain `EntityType` has `country`, but a `char(2)` cannot be a uuid subject).
4. **No lineage for derived values.** Brief §5 demands "what calculations depend on it". Add `evidence.fact_derivations(derived_fact_version_id, input_fact_version_id, calculation_run_id)` and `valuation.calculation_run_inputs(calculation_run_id, fact_version_id | assumption_version_id)`. Add `thesis_nodes.calculation_run_id`. Implemented: `valuation_runs` generalised to `valuation.calculation_runs`, one table for every deterministic-engine invocation (ratios and valuations alike).
5. **Claims have no stable identity across runs.** Drift diff impossible. Add `claim_key text` (subject + claim type + qualifier) with index; add append-only `claim_status_events` instead of mutating `epistemic_status` in place.
6. **Documents not linked to entities.** Ingestion cannot answer "filings for company X". Add `research.document_subjects(document_id, entity_id, role)`. Also `documents unique(source_id, external_id)` allows duplicates when `external_id` is null: use `unique nulls not distinct` (PG15+) or a partial unique on `canonical_url`.
7. **Temporal ranges unconstrained.** Use `tstzrange` + `exclude using gist (fact_id with =, effective_range with &&)` (needs `btree_gist`) on fact versions and listings. Rename `fact_versions.valid_from/valid_to` → `effective_from/effective_to` (system acceptance window) to stop confusion with `period_*` / `as_of_date` (world time). Document the five axes in `docs/domain/time.md`.
8. **`version_no` races.** Assign through one SQL function that locks the parent row, for `fact_versions`, `assumption_versions`, `thesis_versions`, `document_versions`.
9. **`scenario_assumptions` can hold two versions of one assumption.** Add `assumption_id` column, composite FK to `assumption_versions(id, assumption_id)`, `unique(scenario_id, assumption_id)`.
10. **Missing links.** `claims.module_run_id`; `module_runs.prompt_version_id`; `valuation_runs.research_run_id` + `status`; `thesis_versions.research_run_id NOT NULL` (rule 9); `verification_checks.claim_id`; `alert_events.trigger_ref_type/id` + `dedupe_key`; `runs.as_of_date NOT NULL` (domain has it, schema does not); `runs.idempotency_key unique`; `runs.recipe_id NOT NULL`.
11. **Enumerations unchecked.** `status`, `epistemic_status`, `verdict`, `node_type`, `edge_type`, `evidence_role`, `relationship_type`, `security_type` are free text. Add check constraints.
12. **Indexes missing.** `facts(entity_type, entity_id)`, `fact_versions(fact_id, version_no desc)`, `claims(run_id)`, `module_runs(run_id)`, `document_versions(document_id, version_no desc)`, `alert_events(alert_rule_id, created_at desc)`, chunks `tsvector` GIN, chunks `hnsw` when embeddings are used.
13. **Embedding lock-in.** `vector(1536)` hard-codes one provider's dimension. Add `embedding_model`. Better: defer pgvector; single-company retrieval in V1 works on `tsvector` + `section_path`. Add embeddings when retrieval evals show a gap.
14. **Snapshot bloat.** `input_snapshot jsonb` on both `runs` and `module_runs` duplicates evidence content. Add `research.snapshots(id, content_hash, storage_uri, manifest jsonb)`; runs reference a snapshot; module runs store a context manifest of ids only.
15. **Naming.** Boundary doc says `financial_facts`, schema says `research.facts`. `company_relationships` is generic entity relationships. `TradingEvent` is not a trading product. Move sources/documents/facts into an `evidence` schema; keep runs/claims/thesis in `research`; rename to `entity_relationships` and `PlatformEvent`.
16. **Ontology gaps vs brief §17.** No elements, supply-chain stages, end markets, countries, technologies, customers. V1 needs stages, elements, countries (the rare-earth chain is defined by them). `facilities` needs `stage` and primary material.

### Domain types (`domain.ts`)

17. `ResearchContext.facts: Record<string, unknown>` is an untyped bag. Replace with `FactView[]` carrying `factVersionId`, definition code, value, unit, period, status, source tier. Modules must cite ids.
18. Two dependency declarations (`ResearchModuleDefinition.requires` vs recipe `depends_on`) will drift. One source of truth: module declares `requires`; recipe = ordered set of `(module id, version)`; DAG derived and validated at recipe load.
19. `Thesis` lacks `id`, `subjectType`, `subjectId`, `researchRunId` (rule 9 violated at type level). `ValuationResult` lacks `reverse_dcf` and `valuationRunId`. `Claim` lacks `runId`, `moduleRunId`, `claimKey`. `inputSchema: unknown` → `z.ZodType<TInput>`.
20. Module interface: add `kind: 'llm' | 'deterministic' | 'hybrid'` so the orchestrator knows which need the gateway and which must reproduce bit-for-bit. `run()` must have no persistence capability.

### Events (`events.ts`)

21. No version on the envelope. Add `version` or `.v1` suffix. Add `correlationId` (run id), `causationId`, `idempotencyKey`. Missing events: `research.run.completed`, `research.run.failed`, `fact.candidate.proposed`, `fact.promoted`, `claim.status.changed`, `assumption.approved`, `verification.completed`, `market.observation.ingested`, `thesis.drift.detected`.

### Recipe (`company-deep-research.yaml`)

22. **`valuation` as an LLM module violates rule 6.** Split: `valuation-assumptions` (LLM proposes) → `assumption-policy` (deterministic validate/approve) → `valuation-calc` (Python, no LLM) → `scenario-model` (deterministic over approved sets). `numerical-check` verifies every number a module quotes against fact versions and calculation outputs.
23. **No evidence-collection stage.** Recipe assumes documents exist. Add precondition: ingestion job ensures filings present for the subject; snapshot taken afterwards. Otherwise a run on empty evidence produces confident `UNKNOWN` laundering.
24. **Missing `bear-case`.** Brief §11 and §13 make disagreement a core mechanism. Add `bear-case` depending on `risks`, `valuation`, `competitive-landscape`; `contradiction-check` consumes it.
25. Naming: kebab in YAML and directories, snake in brief and DB. Decide: snake_case module codes in data; kebab for directories.

### Repository structure

26. Duplicates: `packages/db` vs `database/`; `evals/` vs `services/ai/evaluation`. Keep `packages/db/migrations` and top-level `evals/`.
27. Premature: `apps/api`, `infra/terraform`, `workers/` as a separate tree (Inngest functions are served from a Next route anyway). V1 layout: `apps/web`, `packages/{domain, schemas, db, events, research, ingestion, ai, monitoring, ontology}`, `services/analytics` (Python), `evals/`, `docs/`, `infra/docker`. Promote packages to `services/` when a second app exists.
28. Dependency diagram wrong (domain above services). Correct: `web → feature packages → domain / schemas / db`. Enforce with eslint boundaries or tsconfig project references.

### Rule change proposals (brief §24 format)

- **Rule 7, extend.** Current: every material claim has evidence or is marked. Problem: allows a `VERIFIED` claim backed by tier-5 evidence. Proposed: "a claim's epistemic status cannot exceed the strongest status of its supporting evidence." Superior: makes status computable and mechanically checkable.
- **New rule 13.** "Financial-statement facts for filers with structured data (XBRL, ESEF) are extracted deterministically; LLM extraction only where no structured source exists." Problem: current design implies LLM extraction for all facts, the largest error surface. Superior: removes that class for US and EU filers at zero model cost.
- **New rule 14.** "Every LLM citation carries a verbatim quote that is deterministically verified against the cited chunk before persistence." Problem: rule 7 requires references but not that they are real.

---

## J. Recommended implementation sequence

Principle: one company end to end before breadth. Seed with MP Materials (US filer, XBRL available, rare earths). Every phase ends with a runnable check.

| # | Phase | Deliverable | Check |
|---|---|---|---|
| 0 | Bootstrap | pnpm monorepo, TS strict, Vitest; docker-compose PostgreSQL 16 + pgvector; plain SQL migrations (dbmate); Python 3.12 + uv + pytest; CI lint/test | `pnpm test`, `pytest` green on empty repo |
| 1 | Schema v1.1 + contracts | Apply I.1–16; `packages/domain` (I.17–20); `packages/schemas` Zod mirrors; `packages/db` thin SQL-first repositories | migration up/down; constraint tests (candidate cannot be current; scenario cannot hold two versions) |
| 2 | Identity | companies / securities / listings / aliases; `core.entities`; deterministic entity resolution (CIK, ISIN, ticker); seed 5 rare-earth issuers; search endpoint | resolve "MP" → MP Materials by CIK |
| 3 | Ingestion vertical | EDGAR connector → documents / versions / chunks (hashed, immutable, stored); XBRL companyfacts → promoted `VERIFIED` financial facts, no LLM | re-ingest idempotent; content-hash dedupe |
| 4 | Analytics engine | Python pure functions: ratios, DCF, reverse DCF, multiples, FCF yield; `engine_version`; FastAPI `POST /calc/{method}`; `CALCULATED` facts with derivations | golden tests vs hand-computed cases |
| 5 | LLM gateway | One provider adapter; structured output via Zod → JSON schema; `model_runs` logging; response cache by request hash; cost tracking; routing config (cheap tier for extraction/classification, strong tier for synthesis/verification) | replay from cache reproduces output |
| 6 | Module runtime + 3 modules | Context builder from snapshot; validator pipeline; append-only persistence; orchestrator as one Inngest function; modules `company-profile`, `financial-quality`, `commodity-exposure` | run completes; every claim has verified quote |
| 7 | Verification | Deterministic: quote containment, numbers-vs-facts, tier coverage, contradiction on same `claim_key` → checks + status events | planted bad citation rejected |
| 8 | Decision | `valuation-assumptions` → policy → scenarios → `valuation_runs`; `final-synthesis` → thesis version with nodes/edges | thesis vN links run, claims, assumption versions, valuation run |
| 9 | Web read models | Company page (thesis, confidence, assumptions, valuation range, risks/catalysts, evidence counts, what changed); evidence drill-down claim → quote → document; run trigger + status; Better Auth minimal | user opens MP page, clicks a number, lands on the filing page |
| 10 | Monitoring v1 | New filing → re-ingest → affected claims via `claim_evidence` → drift report vs last thesis → `alert_events`; types `new_primary_source`, `assumption_invalidated`, `valuation_threshold` | ingest 10-Q → alert fires with trigger ref |
| 11 | Breadth | Remaining modules, `bear-case`, supply-chain ontology (stages, elements, relationships), deterministic bottleneck metrics (concentration indices) | supply-chain page for NdPr |
| 12 | Evals | Extraction vs XBRL, citation validity, numerical consistency, temporal correctness, contradiction detection; gate module version bumps | eval suite runs in CI |

Defer until measured need: pgvector retrieval, Redis, second LLM provider, portfolio positions, Terraform, event fan-out per module.
