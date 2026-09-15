"""Valuation multiples.

Denominators must be positive. A multiple on negative earnings is arithmetic
without meaning -- it ranks the deepest loss maker as the cheapest stock -- so
it is refused here rather than returned for something downstream to sort on.
"""

from __future__ import annotations

from .ratios import CalculationError

ENGINE = "multiples"


def _require_positive(name: str, value: float) -> None:
    if value <= 0:
        raise CalculationError(f"{name} must be positive for a comparable multiple")


def earnings_per_share(net_income: float, shares_outstanding: float) -> float:
    """Earnings attributable to each share. Basic, not diluted."""
    _require_positive("shares outstanding", shares_outstanding)
    return net_income / shares_outstanding


def price_to_earnings(price_per_share: float, earnings_per_share: float) -> float:
    """Price paid per unit of annual earnings."""
    _require_positive("earnings per share", earnings_per_share)
    return price_per_share / earnings_per_share


def ev_to_ebitda(enterprise_value: float, ebitda: float) -> float:
    """Whole-capital price per unit of pre-tax, pre-capex profit."""
    _require_positive("EBITDA", ebitda)
    return enterprise_value / ebitda


def ev_to_sales(enterprise_value: float, revenue: float) -> float:
    """Whole-capital price per unit of revenue. Survives loss-making years."""
    _require_positive("revenue", revenue)
    return enterprise_value / revenue
