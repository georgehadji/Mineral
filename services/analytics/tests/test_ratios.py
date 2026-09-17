"""Golden cases computed by hand, so a formula change has to be deliberate."""

import pytest

from mineral_analytics import ENGINE_VERSION
from mineral_analytics.ratios import (
    CalculationError,
    enterprise_value,
    fcf_yield,
    free_cash_flow,
    gross_margin,
    net_debt,
    net_debt_to_ebitda,
    net_margin,
    operating_margin,
    return_on_equity,
)


def test_engine_version_is_recorded():
    assert ENGINE_VERSION == "0.3.0"


def test_gross_margin():
    assert gross_margin(revenue=253.4, cost_of_revenue=152.0) == pytest.approx(0.400157, abs=1e-6)


def test_gross_margin_can_be_negative():
    assert gross_margin(revenue=100.0, cost_of_revenue=140.0) == pytest.approx(-0.4)


def test_gross_margin_rejects_zero_revenue():
    with pytest.raises(CalculationError):
        gross_margin(revenue=0.0, cost_of_revenue=10.0)


def test_net_debt_is_negative_when_cash_exceeds_debt():
    assert net_debt(total_debt=680.0, cash_and_equivalents=900.0) == pytest.approx(-220.0)


def test_net_debt_to_ebitda():
    assert net_debt_to_ebitda(total_debt=680.0, cash_and_equivalents=180.0, ebitda=250.0) == pytest.approx(2.0)


def test_net_debt_to_ebitda_rejects_zero_ebitda():
    with pytest.raises(CalculationError):
        net_debt_to_ebitda(total_debt=680.0, cash_and_equivalents=180.0, ebitda=0.0)


def test_enterprise_value_includes_minority_interest():
    assert enterprise_value(
        market_cap=3000.0, total_debt=680.0, cash_and_equivalents=900.0, minority_interest=50.0
    ) == pytest.approx(2830.0)


def test_free_cash_flow_treats_capex_as_positive():
    assert free_cash_flow(operating_cash_flow=310.0, capital_expenditure=220.0) == pytest.approx(90.0)


def test_fcf_yield():
    assert fcf_yield(
        operating_cash_flow=310.0, capital_expenditure=220.0, market_cap=3000.0
    ) == pytest.approx(0.03)


def test_functions_are_pure():
    args = dict(total_debt=680.0, cash_and_equivalents=180.0, ebitda=250.0)
    assert net_debt_to_ebitda(**args) == net_debt_to_ebitda(**args)


def test_operating_and_net_margins_share_the_revenue_denominator():
    assert operating_margin(revenue=253.4, operating_income=40.0) == pytest.approx(0.157853, abs=1e-6)
    assert net_margin(revenue=253.4, net_income=25.0) == pytest.approx(0.098658, abs=1e-6)


def test_return_on_equity():
    assert return_on_equity(net_income=25.0, stockholders_equity=500.0) == pytest.approx(0.05)


def test_return_on_equity_rejects_zero_equity():
    with pytest.raises(CalculationError):
        return_on_equity(net_income=25.0, stockholders_equity=0.0)
