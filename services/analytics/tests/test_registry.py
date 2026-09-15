"""The registry is the contract the database writes against.

A calculated fact is only worth storing if the engine can say what it was
computed from, so the invariants here are about provenance and refusal as much
as about arithmetic.
"""

import pytest

from mineral_analytics.ratios import CalculationError
from mineral_analytics.registry import METHODS, UnknownMethod, calculate

SAMPLES = {
    "ratios": {
        "revenue": 253.4,
        "cost_of_revenue": 152.0,
        "operating_income": 40.0,
        "net_income": 25.0,
        "stockholders_equity": 500.0,
        "operating_cash_flow": 310.0,
        "capital_expenditure": 220.0,
        "total_debt": 680.0,
        "cash_and_equivalents": 900.0,
        "market_cap": 3000.0,
        "ebitda": 250.0,
    },
    "dcf": {
        "base_cash_flow": 100.0,
        "growth_rates": [0.10, 0.10],
        "discount_rate": 0.10,
        "terminal_growth": 0.02,
        "net_debt": 275.0,
        "shares_outstanding": 100.0,
    },
    "reverse_dcf": {
        "equity_value": 1200.0,
        "base_cash_flow": 100.0,
        "years": 2,
        "discount_rate": 0.10,
        "terminal_growth": 0.02,
        "net_debt": 275.0,
    },
    "pe": {"price_per_share": 45.0, "net_income": 250.0, "shares_outstanding": 100.0},
    "ev_ebitda": {"enterprise_value": 2830.0, "ebitda": 250.0},
    "ev_sales": {"enterprise_value": 2830.0, "revenue": 253.4},
    "fcf_yield": {"operating_cash_flow": 310.0, "capital_expenditure": 220.0, "market_cap": 3000.0},
}


def test_every_method_has_a_worked_example():
    assert set(SAMPLES) == set(METHODS)


@pytest.mark.parametrize("method", sorted(SAMPLES))
def test_every_output_names_inputs_the_method_actually_accepts(method):
    spec = METHODS[method]
    accepted = set(spec.required) | set(spec.optional)
    result = calculate(method, SAMPLES[method])
    assert result.outputs
    for output in result.outputs:
        assert output.code and output.unit
        assert set(output.inputs) <= accepted, f"{output.code} claims an input {method} cannot take"


def test_a_code_means_the_same_thing_in_every_method():
    seen: dict[str, tuple[str, str]] = {}
    for method, inputs in SAMPLES.items():
        for output in calculate(method, inputs).outputs:
            previous = seen.setdefault(output.code, (output.name, output.unit))
            assert previous == (output.name, output.unit), f"{output.code} disagrees with itself"


def test_ratios_computes_what_it_can_and_nothing_else():
    result = calculate("ratios", {"revenue": 253.4, "cost_of_revenue": 152.0})
    assert [o.code for o in result.outputs] == ["gross_margin"]
    assert result.outputs[0].value == pytest.approx(0.400157, abs=1e-6)


def test_ratios_refuses_a_request_it_can_compute_nothing_from():
    with pytest.raises(CalculationError, match="no ratio"):
        calculate("ratios", {"revenue": 253.4})


def test_dcf_reaches_the_hand_computed_answer_through_the_registry():
    outputs = {o.code: o.value for o in calculate("dcf", SAMPLES["dcf"]).outputs}
    assert outputs["dcf_enterprise_value"] == pytest.approx(1475.0)
    assert outputs["dcf_equity_value"] == pytest.approx(1200.0)
    assert outputs["dcf_value_per_share"] == pytest.approx(12.0)


def test_dcf_keeps_its_workings():
    detail = calculate("dcf", SAMPLES["dcf"]).detail
    assert detail["projected_cash_flows"] == pytest.approx([110.0, 121.0])
    assert detail["terminal_value"] == pytest.approx(1542.75)


def test_reverse_dcf_returns_the_growth_the_price_implies():
    outputs = {o.code: o.value for o in calculate("reverse_dcf", SAMPLES["reverse_dcf"]).outputs}
    assert outputs["implied_growth_rate"] == pytest.approx(0.10, abs=1e-9)


def test_pe_derives_earnings_per_share_when_it_is_not_given():
    codes = [o.code for o in calculate("pe", SAMPLES["pe"]).outputs]
    assert codes == ["earnings_per_share", "pe_ratio"]


def test_monetary_outputs_take_the_currency_and_ratios_do_not():
    units = {o.code: o.unit for o in calculate("dcf", SAMPLES["dcf"], currency="AUD").outputs}
    assert units["dcf_value_per_share"] == "AUD"
    ratio_units = {o.code: o.unit for o in calculate("ratios", SAMPLES["ratios"], currency="AUD").outputs}
    assert ratio_units["gross_margin"] == "ratio"
    assert ratio_units["net_debt"] == "AUD"


def test_an_unknown_input_is_refused_rather_than_ignored():
    with pytest.raises(CalculationError, match="does not take"):
        calculate("ev_sales", {"enterprise_value": 2830.0, "revenue": 253.4, "revnue": 1.0})


def test_a_missing_input_names_itself():
    with pytest.raises(CalculationError, match="revenue"):
        calculate("ev_sales", {"enterprise_value": 2830.0})


def test_an_unknown_method_lists_the_known_ones():
    with pytest.raises(UnknownMethod, match="ev_sales"):
        calculate("black_scholes", {})


def test_non_finite_inputs_are_refused():
    with pytest.raises(CalculationError, match="finite"):
        calculate("ev_sales", {"enterprise_value": float("inf"), "revenue": 253.4})


def test_the_engine_holds_no_state_between_calls():
    first = calculate("dcf", SAMPLES["dcf"])
    second = calculate("dcf", SAMPLES["dcf"])
    assert first == second
