"""Drift monitoring: PSI checked by hand, and the tests on known shifts."""

import math

import numpy as np
import pytest

import monitoring as mon


def test_psi_matches_hand_calculation():
    expected = np.array([0.5, 0.5])
    actual = np.array([0.6, 0.4])
    by_hand = (0.6 - 0.5) * math.log(0.6 / 0.5) + (0.4 - 0.5) * math.log(0.4 / 0.5)
    assert mon.psi(expected, actual) == pytest.approx(by_hand)
    assert mon.psi(expected, expected) == 0


def test_identical_data_is_stable():
    rng = np.random.default_rng(0)
    rows = [{"x": float(v), "c": "a" if v > 0 else "b"} for v in rng.normal(0, 1, 500)]
    r = mon.compare(rows, rows, ["x", "c"])
    assert r["overall"] == "stable"
    assert all(f["psi"] == 0 for f in r["features"])


def test_shifted_numbers_and_new_categories_are_flagged():
    rng = np.random.default_rng(1)
    ref = [{"x": float(v), "plan": "basic" if i % 2 else "pro"} for i, v in enumerate(rng.normal(0, 1, 800))]
    cur = [{"x": float(v), "plan": "enterprise" if i % 3 == 0 else "pro"} for i, v in enumerate(rng.normal(1.5, 1, 800))]
    r = mon.compare(ref, cur, ["x", "plan"])
    by = {f["feature"]: f for f in r["features"]}
    assert by["x"]["level"] == "major" and by["x"]["significant"] is True
    assert by["x"]["current"]["mean"] == pytest.approx(1.5, abs=0.15)
    assert by["plan"]["unseenValues"] == ["enterprise"]
    assert by["plan"]["unseenRows"] == 267
    assert r["overall"] == "major"


def test_missing_feature_column_is_reported():
    r = mon.compare([{"x": 1}] * 10, [{"y": 1}] * 10, ["x"])
    assert r["missingColumns"] == ["x"] and r["features"][0]["missingColumn"] is True


def test_endpoint(client):
    rows = [{"x": float(i)} for i in range(50)]
    r = client.post("/monitor/drift", json={"reference_data": rows, "current_data": rows, "features": ["x"]})
    assert r.status_code == 200 and r.json()["overall"] == "stable"
    assert client.post("/monitor/drift", json={"reference_data": [], "current_data": rows, "features": ["x"]}).status_code == 400
