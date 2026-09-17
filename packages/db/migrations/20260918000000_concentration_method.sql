-- migrate:up

-- Report J.11 adds deterministic bottleneck metrics, and they have to be
-- stored like every other calculated number: a run row naming the engine, the
-- inputs it was given and what came out.
--
-- Rule change, brief section 24. Current rule: valuation.calculation_runs.method
-- is checked against a list of ten valuation methods. Problem: a concentration
-- index is not one of them, so a stored run would violate the constraint, and
-- the alternative -- computing the index when the page is rendered -- breaks
-- invariant C.9, which says a read model may not derive a number that is not
-- already stored. Change: 'concentration' joins the list. Why: the table is
-- already the right shape. It records one invocation of the deterministic
-- engine against one subject with an input snapshot and an output, and its
-- subject_id is a core.entities id, so a material or a supply-chain stage is
-- as valid a subject as a company. What it is not is a valuation-only table;
-- the schema comment calls it a calculation run, which is what this is.

alter table valuation.calculation_runs
  drop constraint calculation_runs_method_check;

alter table valuation.calculation_runs
  add constraint calculation_runs_method_check check (method in (
    'ratios','dcf','reverse_dcf','pe','ev_ebitda','ev_sales','fcf_yield',
    'nav','sotp','scenario','concentration'
  ));

-- migrate:down

alter table valuation.calculation_runs
  drop constraint calculation_runs_method_check;

alter table valuation.calculation_runs
  add constraint calculation_runs_method_check check (method in (
    'ratios','dcf','reverse_dcf','pe','ev_ebitda','ev_sales','fcf_yield',
    'nav','sotp','scenario'
  ));
