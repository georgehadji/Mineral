"""HTTP surface over the deterministic engine.

The transport validates and reports; it never calculates. Every formula lives
in the pure modules, so the same numbers come out of a test, a script or this
service, and a stored result stays reproducible from its input snapshot.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import ENGINE_VERSION
from .ratios import CalculationError
from .registry import METHODS, UnknownMethod, calculate


class CalcRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    inputs: dict[str, float | list[float]]
    #: Unit stamped on monetary outputs. The engine does no conversion, so the
    #: caller is responsible for every input already being in this currency.
    currency: str = Field(default="USD", min_length=3, max_length=3)


class CalcOutput(BaseModel):
    code: str
    name: str
    value: float
    unit: str
    inputs: list[str]


class CalcResponse(BaseModel):
    method: str
    engine: str
    engine_version: str
    currency: str
    inputs: dict[str, float | list[float]]
    outputs: list[CalcOutput]
    detail: dict[str, Any]


app = FastAPI(
    title="Mineral analytics",
    version=ENGINE_VERSION,
    summary="Deterministic financial calculations. No model, no network, no stored state.",
)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "engine_version": ENGINE_VERSION, "methods": sorted(METHODS)}


@app.get("/methods")
def methods() -> dict[str, Any]:
    """What each method needs. Callers use it to send only accepted inputs."""
    return {
        name: {"engine": spec.engine, "required": list(spec.required), "optional": list(spec.optional)}
        for name, spec in sorted(METHODS.items())
    }


@app.post("/calc/{method}", response_model=CalcResponse)
def calc(method: str, request: CalcRequest) -> CalcResponse:
    try:
        result = calculate(method, request.inputs, currency=request.currency)
    except UnknownMethod as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except CalculationError as error:
        # 422: the request was well formed, the numbers in it were not.
        raise HTTPException(status_code=422, detail=str(error)) from error

    return CalcResponse(
        method=result.method,
        engine=result.engine,
        engine_version=ENGINE_VERSION,
        currency=request.currency,
        inputs=request.inputs,
        outputs=[
            CalcOutput(code=o.code, name=o.name, value=o.value, unit=o.unit, inputs=list(o.inputs))
            for o in result.outputs
        ],
        detail=result.detail,
    )
