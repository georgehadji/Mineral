"""Golden cases for the concentration indices, hand-computed."""

from __future__ import annotations

import pytest

from mineral_analytics import concentration
from mineral_analytics.ratios import CalculationError
from mineral_analytics.registry import calculate


def test_one_producer_is_total_concentration():
    assert concentration.hhi([100.0]) == 1.0
    assert concentration.top_share([100.0]) == 1.0
    assert concentration.effective_producers([100.0]) == 1.0


def test_equal_producers_give_one_over_n():
    assert concentration.hhi([25.0, 25.0, 25.0, 25.0]) == pytest.approx(0.25)
    assert concentration.effective_producers([25.0, 25.0, 25.0, 25.0]) == pytest.approx(4.0)


def test_hhi_is_the_sum_of_squared_shares():
    # 0.6^2 + 0.3^2 + 0.1^2 = 0.36 + 0.09 + 0.01
    assert concentration.hhi([60.0, 30.0, 10.0]) == pytest.approx(0.46)


def test_scale_does_not_change_concentration():
    assert concentration.hhi([60.0, 30.0, 10.0]) == pytest.approx(concentration.hhi([6.0, 3.0, 1.0]))


def test_shares_come_back_largest_first_and_sum_to_one():
    result = concentration.shares([10.0, 70.0, 20.0])
    assert result == pytest.approx([0.7, 0.2, 0.1])
    assert sum(result) == pytest.approx(1.0)


def test_cr_n_adds_the_largest_n():
    assert concentration.concentration_ratio([50.0, 30.0, 15.0, 5.0], 2) == pytest.approx(0.8)


def test_cr_n_is_everything_when_n_exceeds_the_producers():
    assert concentration.concentration_ratio([50.0, 50.0], 4) == pytest.approx(1.0)


def test_a_zero_producer_does_not_change_the_index():
    assert concentration.hhi([60.0, 30.0, 10.0, 0.0]) == pytest.approx(0.46)


@pytest.mark.parametrize(
    "quantities",
    [[], [0.0], [-1.0, 2.0], [float("nan")], [float("inf")], [True]],
)
def test_refuses_input_it_cannot_turn_into_shares(quantities):
    with pytest.raises(CalculationError):
        concentration.hhi(quantities)


def test_registry_returns_the_four_indices_and_the_shares_behind_them():
    result = calculate("concentration", {"quantities": [60.0, 30.0, 10.0]}, currency="USD")
    by_code = {output.code: output for output in result.outputs}

    assert result.engine == "concentration"
    assert by_code["hhi"].value == pytest.approx(0.46)
    assert by_code["effective_producers"].value == pytest.approx(1 / 0.46)
    assert by_code["top_share"].value == pytest.approx(0.6)
    # Three producers, so the top four are all of them.
    assert by_code["cr4"].value == pytest.approx(1.0)
    assert result.detail["shares"] == pytest.approx([0.6, 0.3, 0.1])
    assert result.detail["producer_count"] == 3


def test_labels_are_carried_into_the_detail_ranked_but_never_computed_with():
    result = calculate(
        "concentration",
        {"quantities": [10.0, 70.0, 20.0], "labels": ["Third", "First", "Second"]},
    )
    assert [row["label"] for row in result.detail["by_producer"]] == ["First", "Second", "Third"]
    assert result.detail["by_producer"][0]["share"] == pytest.approx(0.7)


def test_top_n_is_configurable():
    result = calculate("concentration", {"quantities": [50.0, 30.0, 15.0, 5.0], "top_n": 2})
    by_code = {output.code: output for output in result.outputs}
    assert by_code["cr2"].value == pytest.approx(0.8)


def test_every_index_names_the_quantities_it_came_from():
    result = calculate("concentration", {"quantities": [1.0, 1.0]})
    for output in result.outputs:
        assert output.inputs == ("quantities",)
