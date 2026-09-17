"""Deterministic analytics engine.

Every function here is pure: same inputs, same output, forever. Results are
persisted with ``ENGINE_VERSION`` so a stored number can always be recomputed
(rule 3). Bump the version whenever a formula changes, or whenever the set
of methods does: 0.3.0 added the concentration indices of report J.11.
"""

ENGINE_VERSION = "0.3.0"

__all__ = ["ENGINE_VERSION"]
