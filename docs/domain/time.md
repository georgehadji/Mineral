# Time axes

Every fact carries up to six timestamps. They answer different questions and are never collapsed (invariant C.11).

| Column | Table | Question | Example |
|---|---|---|---|
| `published_at` | `evidence.documents` | When was the world told? | 10-K filed 2025-03-01 |
| `captured_at` | `evidence.document_versions` | When did we fetch these exact bytes? | 2025-09-14 02:11 |
| `period_start` / `period_end` | `evidence.facts` | Which interval does the value describe? | FY2024 = 2024-01-01 .. 2024-12-31 |
| `as_of_date` | `evidence.facts` | Point-in-time snapshot date (balance sheet, capacity "as of") | 2024-12-31 |
| `observed_at` | `evidence.fact_versions` | When was the value extracted from the source? | 2025-09-14 02:12 |
| `effective_from` / `effective_to` | `evidence.fact_versions` | In which window is this revision the accepted one? | v1: 2025-03-01 .. 2025-06-01; v2: 2025-06-01 .. |

Rules:

- `period_*` and `as_of_date` are world time. They are part of the fact's identity. A restatement of FY2024 revenue is a new *version* of the same fact, not a new fact.
- `effective_*` is system acceptance time. Set only by `evidence.promote_fact_version()`. At most one promoted revision per instant, enforced by an exclusion constraint.
- `published_at` decides staleness. A fact whose source is older than a newer document of the same type for the same entity is a `STALE` candidate.
- `captured_at` decides reproducibility. A research run snapshot references document version ids, so re-running against the same snapshot sees the same bytes.
- Fiscal years are not calendar years. Store the real period; never infer FY from a year label. Lynas FY ends 30 June.
- Capacity, production, and guidance need a `basis` qualifier (`announced`, `planned`, `construction`, `commissioned`, `nameplate`, `operating`, `actual`, `expected`). Same number with a different basis is a different fact.
- `research.runs.as_of_date` is the analytical "today" of a run. Modules see nothing published after it.
