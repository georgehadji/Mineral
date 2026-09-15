"""Ratio calculations over promoted fact values."""

from __future__ import annotations

ENGINE = "ratios"


class CalculationError(ValueError):
    """Raised when inputs cannot produce a defined result."""


def _require_defined(name: str, value: float) -> None:
    if value == 0:
        raise CalculationError(f"{name} is zero; ratio undefined")


def gross_margin(revenue: float, cost_of_revenue: float) -> float:
    """Gross profit as a fraction of revenue."""
    _require_defined("revenue", revenue)
    return (revenue - cost_of_revenue) / revenue


def operating_margin(revenue: float, operating_income: float) -> float:
    """Operating income as a fraction of revenue."""
    _require_defined("revenue", revenue)
    return operating_income / revenue


def net_margin(revenue: float, net_income: float) -> float:
    """Net income as a fraction of revenue."""
    _require_defined("revenue", revenue)
    return net_income / revenue


def return_on_equity(net_income: float, stockholders_equity: float) -> float:
    """Net income against the equity that stood at the period end."""
    _require_defined("stockholders equity", stockholders_equity)
    return net_income / stockholders_equity


def net_debt(total_debt: float, cash_and_equivalents: float) -> float:
    """Debt net of cash. Negative means net cash."""
    return total_debt - cash_and_equivalents


def net_debt_to_ebitda(total_debt: float, cash_and_equivalents: float, ebitda: float) -> float:
    """Leverage in turns of EBITDA."""
    _require_defined("ebitda", ebitda)
    return net_debt(total_debt, cash_and_equivalents) / ebitda


def enterprise_value(
    market_cap: float,
    total_debt: float,
    cash_and_equivalents: float,
    minority_interest: float = 0.0,
) -> float:
    """Equity value plus net debt and minority interest."""
    return market_cap + net_debt(total_debt, cash_and_equivalents) + minority_interest


def free_cash_flow(operating_cash_flow: float, capital_expenditure: float) -> float:
    """Operating cash flow less capital expenditure. Capex is passed positive."""
    return operating_cash_flow - capital_expenditure


def fcf_yield(operating_cash_flow: float, capital_expenditure: float, market_cap: float) -> float:
    """Free cash flow as a fraction of market capitalisation."""
    _require_defined("market_cap", market_cap)
    return free_cash_flow(operating_cash_flow, capital_expenditure) / market_cap
