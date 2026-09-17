"""The method registry behind ``POST /calc/{method}``.

One place that knows what each method needs, what it returns, and what each
returned number was computed from. That last part is the point: a stored
``CALCULATED`` fact has to name its inputs, or it is a number with a story
instead of a derivation.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from . import concentration, multiples, ratios
from .dcf import dcf, project_cash_flows, reverse_dcf
from .ratios import CalculationError

#: Stand-in for the currency the caller passes; the engine is currency-blind.
CURRENCY = "currency"


class UnknownMethod(LookupError):
    """Raised for a method name the registry does not implement."""


@dataclass(frozen=True)
class Output:
    """One calculated number, and the input codes it came from."""

    code: str
    name: str
    value: float
    unit: str
    inputs: tuple[str, ...]


@dataclass(frozen=True)
class CalcResult:
    method: str
    engine: str
    outputs: tuple[Output, ...]
    #: Workings a reviewer would ask for. Stored with the run, never promoted
    #: as facts: they describe the model, not the company.
    detail: dict[str, Any] = field(default_factory=dict)


Runner = Callable[[Mapping[str, Any]], tuple[list[Output], dict[str, Any]]]


@dataclass(frozen=True)
class Method:
    engine: str
    required: tuple[str, ...]
    optional: tuple[str, ...]
    run: Runner


def _num(values: Mapping[str, Any], key: str) -> float:
    value = values.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CalculationError(f"{key} must be a number")
    if not math.isfinite(value):
        raise CalculationError(f"{key} must be finite")
    return float(value)


def _rates(values: Mapping[str, Any], key: str) -> Sequence[float]:
    value = values.get(key)
    if not isinstance(value, (list, tuple)) or not value:
        raise CalculationError(f"{key} must be a non-empty list of growth rates")
    for rate in value:
        if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not math.isfinite(rate):
            raise CalculationError(f"{key} must contain only finite numbers")
    return [float(rate) for rate in value]


def _years(values: Mapping[str, Any], key: str) -> int:
    value = _num(values, key)
    if value != int(value):
        raise CalculationError(f"{key} must be a whole number of years")
    return int(value)


# code, label, unit, input codes in the order the function takes them
_RATIO_OUTPUTS: tuple[tuple[str, str, str, tuple[str, ...], Callable[..., float]], ...] = (
    ("gross_margin", "Gross margin", "ratio", ("revenue", "cost_of_revenue"), ratios.gross_margin),
    ("operating_margin", "Operating margin", "ratio", ("revenue", "operating_income"), ratios.operating_margin),
    ("net_margin", "Net margin", "ratio", ("revenue", "net_income"), ratios.net_margin),
    ("return_on_equity", "Return on equity", "ratio", ("net_income", "stockholders_equity"), ratios.return_on_equity),
    ("net_debt", "Net debt", CURRENCY, ("total_debt", "cash_and_equivalents"), ratios.net_debt),
    ("net_debt_to_ebitda", "Net debt to EBITDA", "x", ("total_debt", "cash_and_equivalents", "ebitda"), ratios.net_debt_to_ebitda),
    ("enterprise_value", "Enterprise value", CURRENCY, ("market_cap", "total_debt", "cash_and_equivalents"), ratios.enterprise_value),
    ("free_cash_flow", "Free cash flow", CURRENCY, ("operating_cash_flow", "capital_expenditure"), ratios.free_cash_flow),
    ("fcf_yield", "Free cash flow yield", "ratio", ("operating_cash_flow", "capital_expenditure", "market_cap"), ratios.fcf_yield),
)


def _ratios(values: Mapping[str, Any]) -> tuple[list[Output], dict[str, Any]]:
    outputs = [
        Output(code, name, fn(*(_num(values, key) for key in inputs)), unit, inputs)
        for code, name, unit, inputs, fn in _RATIO_OUTPUTS
        if all(key in values for key in inputs)
    ]
    if not outputs:
        raise CalculationError("no ratio could be computed from these inputs")
    return outputs, {}


def _dcf(values: Mapping[str, Any]) -> tuple[list[Output], dict[str, Any]]:
    growth_rates = _rates(values, "growth_rates")
    flows = project_cash_flows(_num(values, "base_cash_flow"), growth_rates)
    net_debt = _num(values, "net_debt") if "net_debt" in values else 0.0
    shares = _num(values, "shares_outstanding") if "shares_outstanding" in values else None
    result = dcf(flows, _num(values, "discount_rate"), _num(values, "terminal_growth"), net_debt, shares)

    sources = ("base_cash_flow", "growth_rates", "discount_rate", "terminal_growth")
    outputs = [
        Output("dcf_enterprise_value", "DCF enterprise value", result.enterprise_value, CURRENCY, sources),
        Output("dcf_equity_value", "DCF equity value", result.equity_value, CURRENCY, sources + ("net_debt",)),
    ]
    if result.value_per_share is not None:
        outputs.append(
            Output(
                "dcf_value_per_share",
                "DCF value per share",
                result.value_per_share,
                CURRENCY,
                sources + ("net_debt", "shares_outstanding"),
            )
        )
    detail = {
        "projected_cash_flows": list(flows),
        "discounted_cash_flows": list(result.discounted_cash_flows),
        "pv_explicit": result.pv_explicit,
        "terminal_value": result.terminal_value,
        "pv_terminal": result.pv_terminal,
    }
    return outputs, detail


def _reverse_dcf(values: Mapping[str, Any]) -> tuple[list[Output], dict[str, Any]]:
    years = _years(values, "years")
    growth = reverse_dcf(
        equity_value=_num(values, "equity_value"),
        base_cash_flow=_num(values, "base_cash_flow"),
        years=years,
        discount_rate=_num(values, "discount_rate"),
        terminal_growth=_num(values, "terminal_growth"),
        net_debt=_num(values, "net_debt") if "net_debt" in values else 0.0,
    )
    output = Output(
        "implied_growth_rate",
        "Implied annual growth rate",
        growth,
        "ratio",
        ("equity_value", "base_cash_flow", "years", "discount_rate", "terminal_growth"),
    )
    return [output], {"years": years}


def _pe(values: Mapping[str, Any]) -> tuple[list[Output], dict[str, Any]]:
    outputs: list[Output] = []
    if "earnings_per_share" in values:
        eps = _num(values, "earnings_per_share")
    elif "net_income" in values and "shares_outstanding" in values:
        eps = multiples.earnings_per_share(_num(values, "net_income"), _num(values, "shares_outstanding"))
        outputs.append(
            Output("earnings_per_share", "Earnings per share", eps, CURRENCY, ("net_income", "shares_outstanding"))
        )
    else:
        raise CalculationError("pe needs earnings_per_share, or net_income and shares_outstanding")
    ratio = multiples.price_to_earnings(_num(values, "price_per_share"), eps)
    outputs.append(Output("pe_ratio", "Price to earnings", ratio, "x", ("price_per_share", "earnings_per_share")))
    return outputs, {}


def _ev_ebitda(values: Mapping[str, Any]) -> tuple[list[Output], dict[str, Any]]:
    inputs = ("enterprise_value", "ebitda")
    value = multiples.ev_to_ebitda(_num(values, inputs[0]), _num(values, inputs[1]))
    return [Output("ev_to_ebitda", "EV to EBITDA", value, "x", inputs)], {}


def _ev_sales(values: Mapping[str, Any]) -> tuple[list[Output], dict[str, Any]]:
    inputs = ("enterprise_value", "revenue")
    value = multiples.ev_to_sales(_num(values, inputs[0]), _num(values, inputs[1]))
    return [Output("ev_to_sales", "EV to sales", value, "x", inputs)], {}


def _quantities(values: Mapping[str, Any], key: str) -> Sequence[float]:
    value = values.get(key)
    if not isinstance(value, (list, tuple)) or not value:
        raise CalculationError(f"{key} must be a non-empty list of quantities")
    return [float(q) for q in value] if all(
        not isinstance(q, bool) and isinstance(q, (int, float)) for q in value
    ) else _reject(key)


def _reject(key: str) -> Sequence[float]:
    raise CalculationError(f"{key} must contain only numbers")


def _concentration(values: Mapping[str, Any]) -> tuple[list[Output], dict[str, Any]]:
    """Concentration of one supply-chain stage, from measured quantities.

    The labels are the caller's, carried through into the detail so a stored
    run says who each share belonged to. They take no part in the arithmetic.
    """
    quantities = _quantities(values, "quantities")
    top_n = _years(values, "top_n") if "top_n" in values else 4
    sources = ("quantities",)

    outputs = [
        Output("hhi", "Herfindahl-Hirschman index", concentration.hhi(quantities), "ratio", sources),
        Output(
            "effective_producers",
            "Effective producers",
            concentration.effective_producers(quantities),
            "count",
            sources,
        ),
        Output("top_share", "Largest single share", concentration.top_share(quantities), "ratio", sources),
        Output(
            f"cr{top_n}",
            f"Combined share of the largest {top_n}",
            concentration.concentration_ratio(quantities, top_n),
            "ratio",
            sources,
        ),
    ]

    labels = values.get("labels")
    detail: dict[str, Any] = {
        "shares": concentration.shares(quantities),
        "producer_count": len(quantities),
        "top_n": top_n,
    }
    if isinstance(labels, (list, tuple)) and len(labels) == len(quantities):
        ranked = sorted(zip(labels, quantities), key=lambda pair: pair[1], reverse=True)
        total = float(sum(quantities))
        detail["by_producer"] = [
            {"label": str(label), "quantity": float(q), "share": float(q) / total} for label, q in ranked
        ]
    return outputs, detail


def _fcf_yield(values: Mapping[str, Any]) -> tuple[list[Output], dict[str, Any]]:
    flow_inputs = ("operating_cash_flow", "capital_expenditure")
    flow = ratios.free_cash_flow(_num(values, flow_inputs[0]), _num(values, flow_inputs[1]))
    yield_inputs = flow_inputs + ("market_cap",)
    value = ratios.fcf_yield(*(_num(values, key) for key in yield_inputs))
    return [
        Output("free_cash_flow", "Free cash flow", flow, CURRENCY, flow_inputs),
        Output("fcf_yield", "Free cash flow yield", value, "ratio", yield_inputs),
    ], {}


_RATIO_INPUTS = tuple(
    dict.fromkeys(key for _, _, _, inputs, _ in _RATIO_OUTPUTS for key in inputs)
) + ("minority_interest",)

METHODS: dict[str, Method] = {
    "ratios": Method("ratios", (), _RATIO_INPUTS, _ratios),
    "dcf": Method(
        "dcf",
        ("base_cash_flow", "growth_rates", "discount_rate", "terminal_growth"),
        ("net_debt", "shares_outstanding"),
        _dcf,
    ),
    "reverse_dcf": Method(
        "dcf",
        ("equity_value", "base_cash_flow", "years", "discount_rate", "terminal_growth"),
        ("net_debt",),
        _reverse_dcf,
    ),
    "pe": Method(
        "multiples",
        ("price_per_share",),
        ("earnings_per_share", "net_income", "shares_outstanding"),
        _pe,
    ),
    "ev_ebitda": Method("multiples", ("enterprise_value", "ebitda"), (), _ev_ebitda),
    "ev_sales": Method("multiples", ("enterprise_value", "revenue"), (), _ev_sales),
    "fcf_yield": Method("ratios", ("operating_cash_flow", "capital_expenditure", "market_cap"), (), _fcf_yield),
    "concentration": Method("concentration", ("quantities",), ("labels", "top_n"), _concentration),
}


def calculate(method: str, inputs: Mapping[str, Any], currency: str = "USD") -> CalcResult:
    """Run one method. Unknown inputs are refused, never ignored."""
    spec = METHODS.get(method)
    if spec is None:
        known = ", ".join(sorted(METHODS))
        raise UnknownMethod(f"unknown method {method}; known methods are {known}")

    missing = [key for key in spec.required if key not in inputs]
    if missing:
        raise CalculationError(f"{method} needs {', '.join(missing)}")
    # A silently ignored typo is a wrong number that looks calculated.
    unexpected = [key for key in inputs if key not in spec.required and key not in spec.optional]
    if unexpected:
        raise CalculationError(f"{method} does not take {', '.join(sorted(unexpected))}")

    outputs, detail = spec.run(inputs)
    priced = tuple(
        Output(o.code, o.name, o.value, currency if o.unit == CURRENCY else o.unit, o.inputs) for o in outputs
    )
    return CalcResult(method=method, engine=spec.engine, outputs=priced, detail=detail)
