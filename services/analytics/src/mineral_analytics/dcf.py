"""Discounted cash flow and its inverse.

Two stages: an explicit projection, then a Gordon growth terminal value.
Nothing is read from anywhere -- every assumption arrives as an argument, so a
stored result can always be recomputed from its input snapshot (rule 3).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .ratios import CalculationError

ENGINE = "dcf"


@dataclass(frozen=True)
class DcfResult:
    """Every intermediate a reviewer would ask to see, not just the answer."""

    discounted_cash_flows: tuple[float, ...]
    pv_explicit: float
    terminal_value: float
    pv_terminal: float
    enterprise_value: float
    equity_value: float
    value_per_share: float | None


def project_cash_flows(base_cash_flow: float, growth_rates: Sequence[float]) -> tuple[float, ...]:
    """Compound a base cash flow forward, one growth rate per projected year."""
    if not growth_rates:
        raise CalculationError("a projection needs at least one year")
    flows: list[float] = []
    current = base_cash_flow
    for rate in growth_rates:
        if rate <= -1:
            raise CalculationError("a growth rate at or below -100% ends the cash flow")
        current *= 1 + rate
        flows.append(current)
    return tuple(flows)


def dcf(
    cash_flows: Sequence[float],
    discount_rate: float,
    terminal_growth: float,
    net_debt: float = 0.0,
    shares_outstanding: float | None = None,
) -> DcfResult:
    """Present value of a projection plus its terminal value, bridged to equity."""
    if not cash_flows:
        raise CalculationError("a discounted cash flow needs at least one projected year")
    if discount_rate <= 0:
        raise CalculationError("discount rate must be positive")
    if terminal_growth >= discount_rate:
        raise CalculationError(
            "terminal growth must stay below the discount rate; at or above it "
            "the terminal value is infinite or negative"
        )
    discounted = tuple(
        flow / (1 + discount_rate) ** year for year, flow in enumerate(cash_flows, start=1)
    )
    pv_explicit = sum(discounted)
    terminal_value = cash_flows[-1] * (1 + terminal_growth) / (discount_rate - terminal_growth)
    pv_terminal = terminal_value / (1 + discount_rate) ** len(cash_flows)
    enterprise = pv_explicit + pv_terminal
    equity = enterprise - net_debt
    per_share: float | None = None
    if shares_outstanding is not None:
        if shares_outstanding <= 0:
            raise CalculationError("shares outstanding must be positive")
        per_share = equity / shares_outstanding
    return DcfResult(
        discounted_cash_flows=discounted,
        pv_explicit=pv_explicit,
        terminal_value=terminal_value,
        pv_terminal=pv_terminal,
        enterprise_value=enterprise,
        equity_value=equity,
        value_per_share=per_share,
    )


def reverse_dcf(
    equity_value: float,
    base_cash_flow: float,
    years: int,
    discount_rate: float,
    terminal_growth: float,
    net_debt: float = 0.0,
    bounds: tuple[float, float] = (-0.5, 1.0),
    tolerance: float = 1e-12,
) -> float:
    """The constant growth rate a given equity value already implies.

    Answers "what would have to be true", which is the only honest use of a
    market price in a thesis: it is an input to be explained, not a target.
    """
    if base_cash_flow <= 0:
        raise CalculationError(
            "reverse DCF needs a positive base cash flow; with a negative one "
            "value does not rise with growth and the implied rate is not unique"
        )
    if years < 1:
        raise CalculationError("reverse DCF needs at least one projected year")

    def value_at(growth: float) -> float:
        flows = project_cash_flows(base_cash_flow, [growth] * years)
        return dcf(flows, discount_rate, terminal_growth, net_debt).equity_value

    low, high = bounds
    if low >= high:
        raise CalculationError("search bounds must be ordered")
    low_value, high_value = value_at(low), value_at(high)
    if not low_value <= equity_value <= high_value:
        raise CalculationError(
            f"equity value {equity_value} is outside the values implied by growth "
            f"between {low} and {high} ({low_value} to {high_value})"
        )

    # Value rises monotonically with growth once the base flow is positive, so
    # bisection converges; it is also reproducible, which Newton is not.
    for _ in range(200):
        mid = (low + high) / 2
        if value_at(mid) < equity_value:
            low = mid
        else:
            high = mid
        if high - low < tolerance:
            break
    return (low + high) / 2
