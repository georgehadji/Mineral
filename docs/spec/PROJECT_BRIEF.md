# PROJECT CONTEXT: INVESTMENT RESEARCH OPERATING SYSTEM

You are working with me on the architecture and implementation of a new investment-research application.

I will upload several architecture and implementation files after this prompt. Treat those files as authoritative project context and read them completely before making recommendations or writing code.

The application is NOT intended to be a generic stock tracker, a Bloomberg clone, or a chatbot that generates investment commentary.

The core product is a:

> **Continuous Investment Research Platform / Investment Research Operating System**

Its purpose is to transform fragmented financial, corporate, industrial, commodity, geopolitical, and market information into a continuously updated, evidence-backed investment thesis.

The central product loop is:

```text
QUESTION
   ↓
RESEARCH PLAN
   ↓
DATA
   ↓
EVIDENCE
   ↓
FACTS
   ↓
CLAIMS
   ↓
ANALYSIS
   ↓
DISAGREEMENT
   ↓
VERIFICATION
   ↓
THESIS
   ↓
ASSUMPTIONS
   ↓
VALUATION
   ↓
SCENARIOS
   ↓
DECISION
   ↓
MONITORING
   ↓
NEW EVIDENCE
   ↓
THESIS DRIFT
   ↓
UPDATED THESIS
```

The most important architectural principle is:

> **Evidence before prose. Deterministic calculations before LLM conclusions. Versioned research instead of static reports.**

---

# 1. WHAT WE ARE ACTUALLY BUILDING

Think of the application as five interconnected engines.

```text
┌─────────────────────────────────────┐
│           DATA ENGINE               │
│ market / filings / fundamentals /   │
│ news / commodities / government     │
└──────────────────┬──────────────────┘
                   ↓
┌─────────────────────────────────────┐
│          EVIDENCE ENGINE            │
│ documents / sources / facts /       │
│ claims / citations / provenance     │
└──────────────────┬──────────────────┘
                   ↓
┌─────────────────────────────────────┐
│          ANALYSIS ENGINE            │
│ company / industry / supply chain / │
│ management / competition / risk     │
└──────────────────┬──────────────────┘
                   ↓
┌─────────────────────────────────────┐
│          DECISION ENGINE            │
│ valuation / scenarios / thesis /    │
│ scores / assumptions                │
└──────────────────┬──────────────────┘
                   ↓
┌─────────────────────────────────────┐
│         MONITORING ENGINE            │
│ changes / thesis drift / alerts /   │
│ invalidated assumptions              │
└─────────────────────────────────────┘
```

The UI sits around these engines. It is not the core intellectual asset.

The core intellectual asset should become:

> **Structured, time-aware, source-backed investment knowledge.**

---

# 2. INITIAL DOMAIN FOCUS

The first investment domain is:

**Rare earths → critical minerals → permanent magnets → strategic industrial supply chains**

This is intentional.

We want to prove the platform on a domain where simple stock-screening is insufficient.

The system needs to understand relationships such as:

```text
Element
  ↓
Material
  ↓
Processing stage
  ↓
Facility
  ↓
Company
  ↓
Project
  ↓
Customer
  ↓
End market
```

Example:

```text
Nd / Pr
 ↓
NdPr oxide
 ↓
separation
 ↓
metal
 ↓
NdFeB alloy
 ↓
permanent magnet
 ↓
motor
 ↓
EV / wind / robotics / defense
```

The system should eventually be capable of identifying bottlenecks in such chains.

For example:

- geographic concentration
- processing concentration
- supplier concentration
- permitting time
- qualification time
- substitution difficulty
- capacity constraints
- utilization
- customer concentration
- financing constraints
- geopolitical exposure

This "bottleneck intelligence" is a major intended differentiator.

---

# 3. LESSONS FROM THE REPOSITORIES WE STUDIED

We analyzed four open-source projects.

## AI Berkshire

Primary contribution:

**investment-research methodology**

Important ideas to preserve:

- structured research skills/modules
- investment checklists
- multi-perspective analysis
- exact financial calculations
- industry research
- bottleneck analysis
- management analysis
- thesis tracking
- thesis drift
- source validation
- report auditing
- reproducibility

Do NOT simply copy its Markdown skill architecture.

We are converting the methodology into machine-readable research modules.

Conceptually:

```text
AI Berkshire skill
        ↓
ResearchModule
        ↓
structured inputs
        ↓
evidence
        ↓
structured outputs
        ↓
verification
        ↓
stored research state
```

AI Berkshire is primarily a **methodology reference**.

---

## Fincept Terminal

Primary contribution:

**financial application architecture**

Important ideas:

- bounded contexts
- modular architecture
- event-driven data flow
- DataHub/pub-sub concepts
- typed repositories
- provider separation
- Python analytics
- persistent workflows
- tool/MCP gateway
- financial analytics
- portfolio/risk systems

Do NOT copy its desktop/C++ architecture.

Use its architectural principles selectively.

Fincept is primarily an **architecture reference**.

Also note the licensing implications documented in the repository. Treat it as an architectural reference unless legal/licensing review explicitly permits code reuse.

---

## OpenStock

Primary contribution:

**modern web application engineering**

Useful patterns:

- Next.js App Router
- React
- TypeScript
- Tailwind
- shadcn/Radix
- Better Auth
- command palette/search
- watchlists
- market pages
- TradingView integration
- alerts
- Inngest workflows
- provider abstractions
- Docker
- testing
- API documentation

Do not copy its stock-centric domain model.

Its MongoDB-centered application model should not become our research-data architecture.

OpenStock is primarily a **product-engineering/UI reference**.

---

## Signalist

Primary contribution:

**product/UI patterns**

Useful patterns:

- dashboard
- stock/company pages
- search
- watchlists
- alerts
- TradingView
- authentication
- Inngest workflows
- email workflows

Again, do not inherit its stock-centric architecture.

Signalist is primarily a **UI/product reference**.

---

# 4. THE FOUR REPOSITORIES MUST NOT BECOME THE ARCHITECTURAL BASE

The intended composition is:

```text
AI Berkshire
      ↓
research methodology

Fincept
      ↓
architecture patterns

OpenStock
      ↓
modern application shell

Signalist
      ↓
UI/product patterns

           ↓

      OUR OWN DOMAIN

Evidence
Ontology
Facts
Claims
Research
Verification
Supply Chain
Valuation
Scenarios
Thesis
Monitoring
```

Do not attempt to "merge" these repositories.

We are extracting useful patterns and implementing a coherent clean architecture ourselves.

---

# 5. CORE DATA MODEL

The fundamental provenance chain is:

```text
SOURCE
  ↓
DOCUMENT
  ↓
DOCUMENT VERSION
  ↓
FACT
  ↓
FACT VERSION
  ↓
CLAIM
  ↓
CLAIM EVIDENCE
  ↓
ANALYSIS
  ↓
THESIS
```

Every important investment statement should ultimately be traceable to underlying evidence.

For example:

```text
"Company X has 50 kt/year separation capacity"
```

must be traceable to:

```text
source
→ document
→ document version
→ extracted fact
→ fact version
→ date/as-of semantics
→ claim
```

The system must answer:

- where did the number come from?
- when was the information published?
- when was it valid?
- what document version contained it?
- was it later superseded?
- what calculations depend on it?
- which thesis conclusions depend on it?

---

# 6. TEMPORAL DATA IS A FIRST-CLASS REQUIREMENT

Do not treat facts as timeless.

A statement such as:

> "Company X has 100 kt capacity"

could mean:

- announced capacity
- planned capacity
- construction capacity
- commissioned capacity
- nameplate capacity
- operating capacity
- actual production
- expected future capacity

Therefore important records should support concepts such as:

```text
published_at
observed_at
as_of_date
valid_from
valid_to
supersedes
source_version
```

We need to distinguish:

**When the information was published**

from

**When the information was true.**

This is critical for financial figures, production, guidance, projects, commodity prices, government policy and strategic developments.

---

# 7. EPISTEMIC STATUS

The system should distinguish between different levels of knowledge.

The conceptual taxonomy is:

```text
VERIFIED
CALCULATED
DERIVED
INFERRED
HYPOTHESIS
UNKNOWN
CONTRADICTED
STALE
```

These are not interchangeable.

For example:

```text
Revenue reported by company
→ VERIFIED

Margin calculated from reported numbers
→ CALCULATED

Production capacity derived from multiple documents
→ DERIVED

Potential supply-chain dependency inferred from evidence
→ INFERRED

Future commodity price assumption
→ HYPOTHESIS

Information not yet available
→ UNKNOWN

Two credible sources disagree
→ CONTRADICTED

Old information whose validity is uncertain
→ STALE
```

LLMs must never silently convert hypotheses into facts.

---

# 8. SOURCE HIERARCHY

Source quality should be machine-readable and eventually influence verification/confidence.

Conceptually:

```text
TIER 1
regulatory filings
audited financial statements
government documents
official project documents
official disclosures

TIER 2
exchange disclosures
earnings transcripts
official investor presentations
official technical reports

TIER 3
high-quality industry research
specialist publications
credible institutional research

TIER 4
general news

TIER 5
social media
forums
unverified commentary
```

Critical financial facts should preferentially come from high-tier sources.

Low-quality sources may provide signals, leads or context but should not automatically become authoritative facts.

---

# 9. LLM ARCHITECTURE

LLMs are reasoning components, not authoritative databases.

The basic rule is:

```text
LLM
 ↓
structured proposal
 ↓
validation
 ↓
canonical data
```

Never:

```text
LLM
 ↓
directly write authoritative financial fact
```

Similarly:

```text
LLM proposes valuation assumption
 ↓
structured assumption
 ↓
validation / policy
 ↓
scenario
```

not:

```text
LLM calculates valuation in prose
```

Financial calculations must be deterministic.

The LLM should reason over structured evidence and calculation outputs.

---

# 10. ANALYTICAL ARCHITECTURE

Use TypeScript for application/domain orchestration and Python for deterministic quantitative analysis.

Conceptually:

```text
Next.js / TypeScript
        ↓
domain/service layer
        ↓
research workflow
        ↓
Python analytics service
        ↓
deterministic result
        ↓
stored analytical output
```

Financial calculations should be reproducible independently of the model.

Initial valuation methods:

- DCF
- reverse DCF
- P/E
- EV/EBITDA
- EV/Sales
- FCF yield
- NAV
- SOTP

Later:

- resource-based valuation
- capacity valuation
- commodity-linked valuation
- project valuation
- probabilistic scenarios

---

# 11. RESEARCH MODULE ARCHITECTURE

Research should be modular.

Conceptually:

```text
ResearchModule
 ├── id
 ├── version
 ├── category
 ├── dependencies
 ├── required evidence
 ├── input schema
 ├── output schema
 ├── execution policy
 ├── verification policy
 └── evaluation suite
```

Examples:

```text
entity_resolution
company_profile
business_model
industry_position
commodity_exposure
supply_chain_position
resource_quality
project_pipeline
production_capacity
processing_capacity
magnet_exposure
technology
intellectual_property
customers
geographic_exposure
government_support
competitive_landscape
financial_quality
capital_structure
management
valuation
growth
catalysts
risks
bear_case
base_case
bull_case
scenario_model
contradiction_check
numerical_check
source_check
final_synthesis
```

Do not implement these as giant prompts.

Each module should produce structured state.

---

# 12. RESEARCH RUNS

Research must be persistent and reproducible.

A research run should know:

```text
company
recipe
module versions
model versions
data snapshot
source set
assumptions
execution status
verification status
timestamps
```

The result should be reproducible enough to answer:

> What did the system know, what sources did it have, and what methodology did it use when it generated this thesis?

---

# 13. MULTI-AGENT / MULTI-PERSPECTIVE RESEARCH

Use independent analytical perspectives where they add information.

Do NOT create unnecessary persona agents.

Prefer:

```text
QualityAnalyzer
IndustryStructureAnalyzer
CompetitionAnalyzer
ManagementAnalyzer
RiskAnalyzer
ValuationAnalyzer
BearCaseAnalyzer
CatalystAnalyzer
```

All should operate against the same underlying evidence state.

Their outputs can disagree.

Disagreement must be represented explicitly:

```text
Analysis A
supports claim X

Analysis B
contradicts claim X

Evidence:
...

Resolution:
...
```

The objective is not to make all agents agree.

The objective is to expose disagreement and verify it.

---

# 14. THESIS ENGINE

The investment thesis is a versioned structured object.

It should contain things such as:

```text
conclusion
drivers
assumptions
risks
catalysts
unknowns
valuation
confidence
supporting evidence
contradictory evidence
```

Conceptually:

```text
THESIS
 ├── DRIVER
 ├── ASSUMPTION
 ├── RISK
 ├── CATALYST
 ├── UNKNOWN
 └── CONCLUSION
```

Relationships:

```text
SUPPORTS
CONTRADICTS
DEPENDS_ON
CAUSES
DERIVED_FROM
INVALIDATES
```

A thesis should not be a block of prose.

Prose is a presentation layer over structured thesis state.

---

# 15. MONITORING

The system should continuously compare new information against prior research.

The important concept is:

> **What changed?**

Examples:

```text
new filing
→ revenue changed
→ valuation changed
→ thesis impact

new government announcement
→ project probability changed
→ scenario changed

commodity price movement
→ project economics changed
→ valuation changed

new competitor capacity
→ bottleneck changed
→ strategic position changed
```

The system should eventually detect:

```text
thesis strengthened
thesis weakened
assumption invalidated
new contradiction
risk increased
catalyst confirmed
catalyst delayed
valuation moved
supply-chain structure changed
```

---

# 16. INTELLIGENCE ALERTS

Do not limit alerts to price thresholds.

The future alert model should support:

```text
valuation_threshold
thesis_change
thesis_drift
assumption_invalidated
contradictory_source
new_primary_source
guidance_change
capacity_change
project_delay
commodity_change
bottleneck_change
geopolitical_change
```

This becomes substantially more valuable than a conventional stock alert system.

---

# 17. SUPPLY-CHAIN ONTOLOGY

The first domain model should understand:

### Entities

```text
Company
Security
Listing
Project
Facility
Country
Commodity
Element
Material
Technology
Industry
Theme
Customer
End Market
```

### Supply-chain stages

```text
Mining
Concentration
Separation
Refining
Metal
Alloy
Magnet
Motor
Recycling
```

### Relationships

```text
OWNS
OPERATES
PRODUCES
PROCESSES
SUPPLIES
DEPENDS_ON
LOCATED_IN
USES
COMPETES_WITH
SUBSTITUTES
```

This should begin in PostgreSQL using relational tables and typed relationships.

Do not introduce a dedicated graph database in V1 merely because the domain is graph-like.

---

# 18. V1 TECHNOLOGY DIRECTION

The current intended stack is:

```text
Frontend
Next.js
React
TypeScript
Tailwind
shadcn/Radix
Better Auth

Application
Next.js BFF/API
typed domain services
Inngest

Database
PostgreSQL
pgvector
Redis/cache
object storage

Analytics
Python
NumPy/Pandas
deterministic financial engine

AI
LLM gateway
provider abstraction
structured outputs
tool gateway
model routing

Observability
OpenTelemetry

Testing
Vitest
pytest
evaluation datasets
```

The application should remain modular without prematurely becoming a distributed microservice system.

---

# 19. REPOSITORY STRUCTURE

The uploaded `REPOSITORY_STRUCTURE.md` defines the current intended codebase layout.

Treat it as the baseline unless later analysis identifies a concrete architectural flaw.

The conceptual structure is:

```text
app/
src/
database/
inngest/
evals/
scripts/
tests/
```

with domain areas for:

```text
company
security
data
evidence
ontology
research
valuation
scenarios
scoring
thesis
portfolio
monitoring
llm
policy
```

---

# 20. POSTGRESQL SCHEMA

The uploaded `V1_SCHEMA.sql` is an important implementation artifact.

Read it carefully.

Evaluate whether it adequately supports:

- provenance
- temporal validity
- versioning
- company/security separation
- facts
- claims
- evidence
- research runs
- assumptions
- scenarios
- valuation
- thesis
- monitoring
- alerts

Do not blindly accept the schema.

Identify concrete normalization, integrity, indexing, temporal or concurrency problems before implementation.

---

# 21. DOMAIN TYPES

The uploaded `domain.ts` defines the initial TypeScript domain contracts.

Treat these types as part of the domain boundary rather than as UI types.

Do not allow frontend-specific concerns to leak into core domain objects.

---

# 22. EVENTS

The uploaded `events.ts` defines the initial typed event contracts.

Events should be treated as contracts between workflows and domains.

Do not introduce arbitrary string events throughout the application.

Prefer explicit event types and versioning.

---

# 23. RESEARCH RECIPE

The uploaded `company-deep-research.yaml` defines the first end-to-end research recipe.

Study its dependency graph.

The target pattern is:

```text
entity resolution
      ↓
company profile
      ↓
business / industry
      ↓
commodity / supply chain
      ↓
projects / capacity
      ↓
financial quality
      ↓
capital structure
      ↓
management
      ↓
competition
      ↓
risk / catalysts
      ↓
valuation
      ↓
scenarios
      ↓
verification
      ↓
synthesis
```

The goal is to make this executable through Inngest and the research module system.

---

# 24. IMPLEMENTATION RULES

The uploaded `IMPLEMENTATION_RULES.md` contains additional constraints.

Treat it as part of the architectural specification.

Do not violate these rules casually.

When you believe a rule should change, explain:

1. the current rule
2. the problem
3. the proposed change
4. why the change is superior

Do not silently override architectural decisions.

---

# 25. WHAT THE PRODUCT SHOULD FEEL LIKE

The user should be able to open a company and immediately understand:

```text
Investment Thesis
Research Confidence
Business Quality
Financial Quality
Strategic Position
Supply-Chain Position
Valuation
Bull / Base / Bear
Risks
Catalysts
Key Assumptions
What Changed
Evidence
```

The experience should resemble an institutional research workspace rather than a conventional stock page.

A company page might conceptually look like:

```text
COMPANY X

THESIS
Bullish

Confidence
72 / 100

WHY
1. Strategic processing position
2. Scarce capacity
3. Improving project economics
4. Attractive valuation

KEY ASSUMPTIONS
Commodity price
Utilization
Project timing
Capex

KEY RISKS
Financing
Execution
Commodity prices
Geopolitics

VALUATION
Base: $X
Bull: $Y
Bear: $Z

WHAT CHANGED
+ Government funding
- Project delay

EVIDENCE
17 primary
8 secondary
2 contradictory
```

The chart is useful, but secondary.

---

# 26. WHAT WE ARE NOT BUILDING FIRST

Do not allow scope to expand into:

```text
HFT
full brokerage
Bloomberg replacement
desktop terminal
massive technical-analysis platform
high-frequency trading
complex derivatives trading
social trading
generic autonomous AGI analyst
microservice infrastructure
dedicated graph database
```

These may become useful much later.

They are not the core V1.

---

# 27. V1 PRIORITY

V1 should prove that the platform can perform a complete evidence-backed company investigation.

Minimum functional path:

```text
search company
 ↓
resolve entity/security
 ↓
collect source documents
 ↓
ingest evidence
 ↓
extract facts
 ↓
build claims
 ↓
run research modules
 ↓
verify
 ↓
calculate valuation
 ↓
build thesis
 ↓
display thesis + evidence
 ↓
persist research run
```

This vertical slice is more important than building dozens of UI features.

---

# 28. THE KEY PRODUCT DIFFERENTIATION

A generic AI financial application says:

> "Here is an AI summary of Company X."

Our system should instead say:

> "Here is the current state of our investment thesis on Company X, the evidence supporting it, the evidence contradicting it, the assumptions on which it depends, the valuation implied by those assumptions, and what has changed since the last research cycle."

That distinction should guide every architectural decision.

---

# 29. YOUR ROLE

Act as a senior staff/principal engineer and financial-systems architect.

Do not merely implement what is written.

Continuously challenge the design.

For every significant architectural choice, ask:

```text
Is this necessary?
Is this scalable?
Is this testable?
Is this deterministic where it should be?
Can provenance be preserved?
Can the system explain why it believes something?
Can the output be reproduced?
Can the thesis be updated incrementally?
Can we detect when previous conclusions became invalid?
```

Prefer:

- explicit contracts
- typed interfaces
- immutable/versioned research state
- deterministic calculations
- strong provenance
- testability
- observability
- incremental complexity

Avoid:

- premature abstraction
- agent theater
- giant prompts
- hidden state
- uncontrolled LLM writes
- duplicated business logic
- provider lock-in
- generic “AI magic”

---

# 30. HOW TO WORK WITH ME

When I ask you to implement something:

1. First inspect the existing architecture and relevant files.
2. Determine whether the requested change fits the current design.
3. Identify conflicts or hidden architectural consequences.
4. Propose the smallest coherent implementation.
5. Implement it with production-quality code.
6. Add tests.
7. Explain important architectural decisions.
8. Identify technical debt introduced by the change.
9. Do not redesign unrelated parts of the system without a concrete reason.

When reviewing code, prioritize:

```text
correctness
data integrity
provenance
security
financial accuracy
temporal correctness
testability
maintainability
performance
```

in that approximate order.

---

# 31. IMPORTANT REASONING PRINCIPLE

When there is tension between:

```text
more automation
```

and

```text
more reliability
```

prefer reliability.

When there is tension between:

```text
beautiful prose
```

and

```text
traceable structured reasoning
```

prefer traceability.

When there is tension between:

```text
more features
```

and

```text
a stronger core research loop
```

prefer the research loop.

---

# 32. FIRST TASK AFTER READING THESE FILES

After reading every uploaded file, do NOT immediately write code.

First produce an architectural understanding report with exactly these sections:

### A. System understanding

Explain in your own words what we are building.

### B. Architecture reconstruction

Reconstruct the current proposed architecture from the uploaded artifacts.

### C. Key invariants

List the rules that must never be violated.

### D. Domain model

Explain the most important entities and their relationships.

### E. Data flow

Trace a piece of information from source acquisition to final investment thesis.

### F. Research execution model

Explain how a ResearchRun, ResearchTask and ResearchModule interact.

### G. AI boundaries

Explain what the LLM is allowed and not allowed to do.

### H. Failure modes

Identify the most dangerous ways this system could produce incorrect investment research.

### I. Architectural weaknesses

Challenge the current design and identify what should be changed before implementation.

### J. Recommended implementation sequence

Give the optimal order for implementing the platform.

Do not assume the current artifacts are perfect.

Your job is to understand the system deeply enough that future implementation decisions remain coherent with the overall product.

The ultimate objective is not merely to build a financial application.

It is to build a system that can maintain a **continuously evolving, evidence-backed, auditable investment thesis**.