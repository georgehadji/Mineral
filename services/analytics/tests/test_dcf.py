"""Golden DCF cases, worked through on paper first.

    base free cash flow 100, growing 10% for two years -> 110.00, 121.00
    discounted at 10%                                  -> 100.00, 100.00
    present value of the explicit period               ->   200.00
    terminal value 121 * 1.02 / (0.10 - 0.02)          -> 1,542.75
    discounted by 1.1 squared                          -> 1,275.00
    enterprise value                                   -> 1,475.00
    less net debt 275                                  -> 1,200.00 of equity
    over 100 shares                                    ->    12.00 a share

Every number below is that arithmetic, not this code run once and pasted back.
"""

import pytest

from mineral_analytics.dcf import DcfResult, dcf, project_cash_flows, reverse_dcf
from mineral_analytics.ratios import CalculationError

BASE = dict(discount_rate=0.10, terminal_growth=0.02, net_debt=275.0, shares_outstanding=100.0)


def golden() -> DcfResult:
    flows = project_cash_flows(100.0, [0.10, 0.10])
    return dcf(flows, **BASE)


def test_projection_compounds_year_by_year():
    assert project_cash_flows(100.0, [0.10, 0.10]) == pytest.approx((110.0, 121.0))


def test_projection_accepts_a_different_rate_each_year():
    assert project_cash_flows(100.0, [0.20, -0.10]) == pytest.approx((120.0, 108.0))


def test_present_value_of_the_explicit_period():
    assert golden().pv_explicit == pytest.approx(200.0)


def test_terminal_value_and_its_present_value():
    result = golden()
    assert result.terminal_value == pytest.approx(1542.75)
    assert result.pv_terminal == pytest.approx(1275.0)


def test_enterprise_equity_and_per_share_values():
    result = golden()
    assert result.enterprise_value == pytest.approx(1475.0)
    assert result.equity_value == pytest.approx(1200.0)
    assert result.value_per_share == pytest.approx(12.0)


def test_per_share_is_absent_when_the_share_count_is():
    flows = project_cash_flows(100.0, [0.10, 0.10])
    assert dcf(flows, discount_rate=0.10, terminal_growth=0.02).value_per_share is None


def test_terminal_growth_at_or_above_the_discount_rate_is_refused():
    with pytest.raises(CalculationError):
        dcf([100.0], discount_rate=0.08, terminal_growth=0.08)


def test_a_projection_needs_at_least_one_year():
    with pytest.raises(CalculationError):
        project_cash_flows(100.0, [])


def test_growth_at_minus_one_hundred_percent_is_refused():
    with pytest.raises(CalculationError):
        project_cash_flows(100.0, [-1.0])


def test_zero_shares_is_refused_rather_than_dividing():
    with pytest.raises(CalculationError):
        dcf([100.0], discount_rate=0.10, terminal_growth=0.02, shares_outstanding=0.0)


def test_reverse_dcf_recovers_the_growth_the_forward_case_used():
    implied = reverse_dcf(
        equity_value=1200.0,
        base_cash_flow=100.0,
        years=2,
        discount_rate=0.10,
        terminal_growth=0.02,
        net_debt=275.0,
    )
    assert implied == pytest.approx(0.10, abs=1e-9)


def test_reverse_dcf_reports_a_price_outside_the_search_bracket():
    with pytest.raises(CalculationError, match="outside"):
        reverse_dcf(
            equity_value=10_000_000.0,
            base_cash_flow=100.0,
            years=2,
            discount_rate=0.10,
            terminal_growth=0.02,
        )


def test_reverse_dcf_refuses_a_negative_base_cash_flow():
    with pytest.raises(CalculationError, match="positive base cash flow"):
        reverse_dcf(
            equity_value=1200.0,
            base_cash_flow=-10.0,
            years=2,
            discount_rate=0.10,
            terminal_growth=0.02,
        )


def test_results_are_reproducible():
    assert golden() == golden()
