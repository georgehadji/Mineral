"""Concentration indices: how much of a supply-chain stage sits in few hands.

Report J.11 calls these deterministic bottleneck metrics, and deterministic is
the whole point. A bottleneck claim is the kind of statement a model will
produce confidently from nothing, so the number behind it has to come from a
function that takes measured shares and returns the same answer every time.

The functions take quantities, not shares. Normalising here rather than at the
caller means the shares always sum to one and no caller can pass a set that
does not, which is the mistake that makes an HHI quietly wrong.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

from .ratios import CalculationError


def shares(quantities: Sequence[float]) -> list[float]:
    """Quantities as fractions of their total, largest first."""
    if not quantities:
        raise CalculationError("concentration needs at least one quantity")
    for quantity in quantities:
        if isinstance(quantity, bool) or not isinstance(quantity, (int, float)):
            raise CalculationError("every quantity must be a number")
        if not math.isfinite(quantity):
            raise CalculationError("every quantity must be finite")
        if quantity < 0:
            raise CalculationError("a negative quantity is not a share of anything")
    total = float(sum(quantities))
    if total <= 0:
        raise CalculationError("the quantities sum to zero, so there are no shares")
    return sorted((float(q) / total for q in quantities), reverse=True)


def hhi(quantities: Sequence[float]) -> float:
    """Herfindahl-Hirschman index on a 0 to 1 scale.

    One producer gives 1. n equal producers give 1/n. Reported on the fraction
    scale rather than the competition-authority 0 to 10,000 scale, because
    everything else stored here is a fraction and one scale beats two.
    """
    return sum(share * share for share in shares(quantities))


def effective_producers(quantities: Sequence[float]) -> float:
    """1/HHI: the number of equal-sized producers that would be this concentrated.

    The readable form of the same number. An HHI of 0.25 is hard to place; "as
    concentrated as four equal producers" is not.
    """
    return 1.0 / hhi(quantities)


def top_share(quantities: Sequence[float]) -> float:
    """The largest single share."""
    return shares(quantities)[0]


def concentration_ratio(quantities: Sequence[float], n: int) -> float:
    """CR-n: the combined share of the n largest.

    Where there are fewer than n producers the answer is 1, which is correct
    and worth stating: everything is held by the top n when the top n is
    everyone.
    """
    if n < 1:
        raise CalculationError("a concentration ratio needs at least one producer")
    return sum(shares(quantities)[:n])
