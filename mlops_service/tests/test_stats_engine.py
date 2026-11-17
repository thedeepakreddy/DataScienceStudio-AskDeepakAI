"""Reference tests for the Statistics step: results are checked against
published textbook values or independent calculations, not just shapes."""

import math

import numpy as np
import pandas as pd
import pytest
import scipy.stats as st
from sklearn.linear_model import LogisticRegression

import stats_engine as se


def frame(**cols):
    return pd.DataFrame(cols)


# --- Power: classic values from Cohen (1988), cross-checked with pingouin ------

@pytest.mark.parametrize("test,effect,expected", [
    ("two-sample-t", 0.5, 64),     # medium effect, 80% power: 64 per group
    ("two-sample-t", 0.8, 26),     # large effect: 26 per group
    ("paired-t", 0.5, 34),         # 34 pairs
    ("anova", 0.25, 53),           # f = 0.25, 3 groups: 53 per group (159 total)
    ("correlation", 0.3, 85),      # r = 0.3: 85 in total (Fisher z approximation)
])
def test_sample_size_matches_reference_tables(test, effect, expected):
    r = se.power_analysis(test, effect, alpha=0.05, power=0.8)
    assert r["n"] == expected
    assert r["achievedPower"] >= 0.8


def test_power_for_given_n_is_inverse_of_sample_size():
    r = se.power_analysis("two-sample-t", 0.5, alpha=0.05, n=64)
    assert r["power"] == pytest.approx(0.8015, abs=0.002)


def test_power_rejects_both_or_neither_target():
    with pytest.raises(se.StatsError):
        se.power_analysis("two-sample-t", 0.5)
    with pytest.raises(se.StatsError):
        se.power_analysis("two-sample-t", 0.5, power=0.8, n=10)


# --- Two groups ------------------------------------------------------------------

def test_two_groups_welch_with_ci_and_hedges_g():
    a = [4.2, 4.8, 5.1, 5.5, 6.0, 6.2, 5.9, 5.0]
    b = [3.1, 3.9, 4.0, 4.4, 4.6, 3.8, 4.1, 4.3, 3.6]
    df = frame(value=a + b, group=["A"] * len(a) + ["B"] * len(b))
    r = se.compare(df, "value", "group")
    ref = st.ttest_ind(a, b, equal_var=False)
    assert r["test"] == "Welch’s t-test"
    assert r["pValue"] == pytest.approx(ref.pvalue, rel=1e-5)
    ci = ref.confidence_interval(0.95)
    assert r["estimate"]["ci"] == [pytest.approx(ci.low, abs=1e-5), pytest.approx(ci.high, abs=1e-5)]
    pooled = math.sqrt(((len(a) - 1) * np.var(a, ddof=1) + (len(b) - 1) * np.var(b, ddof=1)) / (len(a) + len(b) - 2))
    d = (np.mean(a) - np.mean(b)) / pooled
    assert r["effectSize"]["value"] == pytest.approx(d * (1 - 3 / (4 * 17 - 9)), abs=1e-4)
    assert r["nonParametric"]["test"] == "Mann–Whitney U test"
    assert r["significant"] is True
    assert {x["name"] for x in r["groups"]} == {"A", "B"}


def test_three_groups_welch_anova_and_tukey():
    rng = np.random.default_rng(1)
    g = {k: rng.normal(m, s, 25) for k, m, s in [("x", 10, 1), ("y", 11, 3), ("z", 13, 1)]}
    df = frame(v=np.concatenate(list(g.values())), grp=sum([[k] * 25 for k in g], []))
    r = se.compare(df, "grp", "v")
    assert r["test"] == "Welch’s ANOVA"
    assert r["significant"] is True
    assert len(r["postHoc"]["comparisons"]) == 3
    kw = st.kruskal(*g.values())
    assert r["nonParametric"]["pValue"] == pytest.approx(kw.pvalue, rel=1e-5)
    assert 0 < r["effectSize"]["value"] < 1


def test_welch_anova_matches_reference_formula():
    # Reference computed with pingouin.welch_anova (an independent
    # implementation): F = 14.171801, df = (2, 6.72353), p = 0.003878,
    # partial eta squared = 0.515316.
    y = [2.0, 3.0, 4.0, 3.0, 5.0, 6.0, 7.0, 6.0, 5.0, 9.0, 8.0, 15.0, 3.0, 11.0]
    grp = ["a"] * 4 + ["b"] * 5 + ["c"] * 5
    r = se.compare(frame(y=y, g=grp), "y", "g")
    assert r["statistic"] == pytest.approx(14.171801, abs=1e-5)
    assert r["df"][1] == pytest.approx(6.72353, abs=1e-4)
    assert r["pValue"] == pytest.approx(0.003878, abs=1e-6)
    assert r["effectSize"]["value"] == pytest.approx(0.515316, abs=1e-5)


# --- Correlation, paired, categories ---------------------------------------------

def test_correlation_with_fisher_ci():
    x = np.arange(1, 21, dtype=float)
    y = x * 2 + np.sin(x) * 3
    r = se.compare(frame(x=x, y=y), "x", "y")
    ref = st.pearsonr(x, y)
    assert r["statistic"] == pytest.approx(ref.statistic, abs=1e-4)
    ci = ref.confidence_interval(0.95)
    assert r["estimate"]["ci"] == [pytest.approx(ci.low, abs=1e-4), pytest.approx(ci.high, abs=1e-4)]


def test_paired_t():
    before = [200, 190, 210, 220, 205, 195, 215, 208]
    after = [195, 185, 205, 210, 204, 190, 210, 200]
    r = se.compare(frame(before=before, after=after), "before", "after", paired=True)
    ref = st.ttest_rel(before, after)
    assert r["test"] == "Paired t-test"
    assert r["pValue"] == pytest.approx(ref.pvalue, rel=1e-5)
    assert r["estimate"]["value"] == pytest.approx(5.5)


def test_chi_squared_with_cramers_v_and_fisher():
    df = frame(a=["x"] * 30 + ["y"] * 30, b=["p"] * 25 + ["q"] * 5 + ["p"] * 10 + ["q"] * 20)
    r = se.compare(df, "a", "b")
    table = np.array([[25, 5], [10, 20]])
    chi2, p, *_ = st.chi2_contingency(table, correction=True)
    assert r["pValue"] == pytest.approx(p, rel=1e-6)
    assert r["effectSize"]["value"] == pytest.approx(math.sqrt(chi2 / 60), abs=1e-4)
    assert r["nonParametric"]["test"] == "Fisher’s exact test"


def test_rejects_bad_inputs():
    with pytest.raises(se.StatsError, match="no column"):
        se.compare(frame(a=[1, 2, 3, 4]), "a", "b")
    with pytest.raises(se.StatsError, match="two different"):
        se.compare(frame(a=[1, 2, 3, 4]), "a", "a")
    with pytest.raises(se.StatsError, match="at least 2 values"):
        se.compare(frame(v=[1, 2, 3, 4, 5], g=["a", "a", "a", "a", "b"]), "v", "g")


# --- Regression -----------------------------------------------------------------------

def test_linear_regression_matches_least_squares_and_textbook_se():
    rng = np.random.default_rng(3)
    x1 = rng.uniform(0, 10, 60)
    cat = rng.choice(["lo", "hi"], 60)
    y = 2 + 1.5 * x1 + np.where(cat == "hi", 4, 0) + rng.normal(0, 1, 60)
    r = se.regression(frame(y=y, x1=x1, cat=cat), "y", ["x1", "cat"], "linear")
    terms = {c["term"]: c for c in r["coefficients"]}
    assert set(terms) == {"(Intercept)", "x1", "cat = lo"}
    assert terms["x1"]["estimate"] == pytest.approx(1.5, abs=0.15)
    assert terms["cat = lo"]["estimate"] == pytest.approx(-4, abs=0.6)
    lin = st.linregress(x1, y)  # sanity check of the SE formula on a 1-predictor model
    r1 = se.regression(frame(y=y, x1=x1), "y", ["x1"], "linear")
    assert r1["coefficients"][1]["se"] == pytest.approx(lin.stderr, rel=1e-6)
    assert r1["fit"]["rSquared"] == pytest.approx(lin.rvalue ** 2, abs=1e-4)


def test_logistic_regression_matches_unpenalised_sklearn():
    rng = np.random.default_rng(5)
    x = rng.normal(0, 1, 400)
    p = 1 / (1 + np.exp(-(0.5 + 1.2 * x)))
    y = np.where(rng.uniform(size=400) < p, "Yes", "No")
    r = se.regression(frame(y=y, x=x), "y", ["x"], "logistic")
    ref = LogisticRegression(C=np.inf).fit(x[:, None], y == "Yes")
    assert r["coefficients"][1]["estimate"] == pytest.approx(ref.coef_[0][0], abs=1e-3)
    assert r["coefficients"][0]["estimate"] == pytest.approx(ref.intercept_[0], abs=1e-3)
    assert r["coefficients"][1]["oddsRatio"] == pytest.approx(math.exp(ref.coef_[0][0]), rel=1e-3)
    assert r["notes"][0].startswith("Models the chance that “y” is “Yes”")


def test_regression_reports_collinearity():
    df = frame(y=[1.0, 2, 3, 4, 5, 6], a=[1.0, 2, 3, 4, 5, 6], b=[2.0, 4, 6, 8, 10, 12])
    with pytest.raises(se.StatsError, match="collinearity"):
        se.regression(df, "y", ["a", "b"], "linear")


def test_endpoints(client):
    rows = [{"v": float(i % 7), "g": "a" if i % 2 else "b"} for i in range(40)]
    assert client.post("/stats/compare", json={"data": rows, "columnA": "v", "columnB": "g"}).status_code == 200
    bad = client.post("/stats/compare", json={"data": rows, "columnA": "v", "columnB": "nope"})
    assert bad.status_code == 400 and "no column" in bad.json()["detail"]
    reg = client.post("/stats/regression", json={"data": rows, "outcome": "v", "predictors": ["g"]})
    assert reg.status_code == 200
    pw = client.post("/stats/power", json={"test": "two-sample-t", "effect": 0.5, "power": 0.8})
    assert pw.json()["n"] == 64
