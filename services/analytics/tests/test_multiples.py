"""Golden multiples, hand-computed.

    net income 250 over 100 shares -> 2.50 of earnings a share
    a 45.00 share price            -> 18.0x earnings
    enterprise value 2,830         -> 11.32x EBITDA of 250
                                   -> 11.168114x revenue of 253.4
"""

import pytest

from mineral_analytics.multiples import (
    earnings_per_share,
    ev_to_ebitda,
    ev_to_sales,
    price_to_earnings,
)
from mineral_analytics.ratios import CalculationError


def test_earnings_per_share():
    assert earnings_per_share(net_income=250.0, shares_outstanding=100.0) == pytest.approx(2.5)


def test_price_to_earnings():
    assert price_to_earnings(price_per_share=45.0, earnings_per_share=2.5) == pytest.approx(18.0)


def test_ev_to_ebitda():
    assert ev_to_ebitda(enterprise_value=2830.0, ebitda=250.0) == pytest.approx(11.32)


def test_ev_to_sales():
    assert ev_to_sales(enterprise_value=2830.0, revenue=253.4) == pytest.approx(11.168114, abs=1e-6)


def test_a_negative_enterprise_value_is_a_real_answer():
    # Market capitalisation below net cash. The multiple is negative and means
    # something; only the denominator has to be positive.
    assert ev_to_sales(enterprise_value=-120.0, revenue=240.0) == pytest.approx(-0.5)


def test_losses_do_not_become_a_cheap_multiple():
    with pytest.raises(CalculationError, match="earnings per share"):
        price_to_earnings(price_per_share=45.0, earnings_per_share=-2.5)
    with pytest.raises(CalculationError, match="EBITDA"):
        ev_to_ebitda(enterprise_value=2830.0, ebitda=-50.0)


def test_zero_denominators_are_refused():
    with pytest.raises(CalculationError):
        ev_to_sales(enterprise_value=2830.0, revenue=0.0)
    with pytest.raises(CalculationError):
        earnings_per_share(net_income=250.0, shares_outstanding=0.0)
