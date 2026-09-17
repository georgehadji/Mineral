"""The HTTP surface carries the same numbers the pure functions produce.

Transport-level tests only: the arithmetic is proved in test_dcf, test_ratios
and test_multiples. What matters here is that nothing is lost or invented
between the wire and the engine.
"""

import pytest
from fastapi.testclient import TestClient

from mineral_analytics import ENGINE_VERSION
from mineral_analytics.api import app

client = TestClient(app)

DCF_BODY = {
    "inputs": {
        "base_cash_flow": 100.0,
        "growth_rates": [0.10, 0.10],
        "discount_rate": 0.10,
        "terminal_growth": 0.02,
        "net_debt": 275.0,
        "shares_outstanding": 100.0,
    }
}


def test_health_reports_the_engine_version_and_methods():
    body = client.get("/health").json()
    assert body["engine_version"] == ENGINE_VERSION
    assert "reverse_dcf" in body["methods"]


def test_dcf_over_http_matches_the_hand_computed_case():
    response = client.post("/calc/dcf", json=DCF_BODY)
    assert response.status_code == 200
    body = response.json()
    assert body["engine"] == "dcf"
    assert body["engine_version"] == ENGINE_VERSION
    assert body["currency"] == "USD"
    values = {o["code"]: o["value"] for o in body["outputs"]}
    assert values["dcf_value_per_share"] == pytest.approx(12.0)


def test_the_response_carries_the_provenance_a_stored_fact_needs():
    body = client.post("/calc/dcf", json=DCF_BODY).json()
    per_share = next(o for o in body["outputs"] if o["code"] == "dcf_value_per_share")
    assert "shares_outstanding" in per_share["inputs"]
    assert body["inputs"] == DCF_BODY["inputs"]
    assert body["detail"]["terminal_value"] == pytest.approx(1542.75)


def test_currency_is_stamped_on_monetary_outputs():
    body = client.post("/calc/dcf", json={**DCF_BODY, "currency": "AUD"}).json()
    units = {o["code"]: o["unit"] for o in body["outputs"]}
    assert units["dcf_equity_value"] == "AUD"


def test_an_unknown_method_is_a_404():
    response = client.post("/calc/black_scholes", json={"inputs": {}})
    assert response.status_code == 404


def test_numbers_that_cannot_produce_a_result_are_a_422():
    response = client.post("/calc/ratios", json={"inputs": {"revenue": 0.0, "cost_of_revenue": 10.0}})
    assert response.status_code == 422
    assert "revenue" in response.json()["detail"]


def test_an_unexpected_body_field_is_rejected():
    response = client.post("/calc/dcf", json={**DCF_BODY, "subject_id": "MP"})
    assert response.status_code == 422


CONCENTRATION_BODY = {
    "inputs": {
        "quantities": [6000.0, 3000.0, 1000.0],
        "labels": ["MP Materials", "USA Rare Earth", "Energy Fuels"],
    },
    "currency": "XXX",
}


def test_concentration_accepts_string_labels_over_the_wire():
    """Labels are strings, and the request model has to carry them unchanged.

    They exist so a stored run says which producer each quantity belonged to,
    so losing them at the boundary would leave an index nobody can read back.
    """
    response = client.post("/calc/concentration", json=CONCENTRATION_BODY)
    assert response.status_code == 200
    body = response.json()
    assert body["inputs"]["labels"] == ["MP Materials", "USA Rare Earth", "Energy Fuels"]
    by_code = {output["code"]: output["value"] for output in body["outputs"]}
    assert by_code["hhi"] == pytest.approx(0.46)
    assert [row["label"] for row in body["detail"]["by_producer"]] == [
        "MP Materials",
        "USA Rare Earth",
        "Energy Fuels",
    ]


def test_concentration_still_refuses_a_label_where_a_quantity_belongs():
    """Widening the request type must not widen what a method will compute with.

    The boundary now carries strings, so this reaches the registry rather than
    being stopped by the request model, and the registry is where it is refused.
    """
    response = client.post(
        "/calc/concentration",
        json={"inputs": {"quantities": ["a lot", "a little"]}},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "quantities must contain only numbers"
