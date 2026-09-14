# Implementation Rules

1. Canonical facts are versioned and source-backed.
2. Raw documents are immutable; corrections create a new document version.
3. Research runs capture an input snapshot and are reproducible from stored state.
4. LLM output is always structured and validated before persistence.
5. LLMs cannot directly write canonical financial facts.
6. Financial calculations are deterministic and versioned independently of the LLM.
7. Every material claim should have one or more evidence references or be explicitly marked as inference/hypothesis/unknown.
8. Every valuation stores its assumptions and calculation-engine version.
9. Every thesis version points to the research run that produced it.
10. Reports are read models derived from evidence, claims, assumptions, valuations, and thesis state.
11. Provider-specific identifiers stay inside provider adapters; domain objects use canonical IDs.
12. V1 prefers PostgreSQL relationships over a dedicated graph database.
