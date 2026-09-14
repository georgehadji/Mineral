"""Deterministic analytics engine.

Every function here is pure: same inputs, same output, forever. Results are
persisted with ``ENGINE_VERSION`` so a stored number can always be recomputed
(rule 3). Bump the version whenever a formula changes.
"""

ENGINE_VERSION = "0.1.0"

__all__ = ["ENGINE_VERSION"]
