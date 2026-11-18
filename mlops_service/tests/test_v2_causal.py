"""Engine v2, phase 3: causal methods recover planted effects; experiment tools match references."""
import numpy as np
import pytest

from conftest import run, upload_rows


@pytest.fixture(scope="module")
def observational(client):
    rng = np.random.default_rng(7)
    rows = []
    for _ in range(3000):
        age = rng.uniform(20, 70)
        income = rng.normal(50, 15)
        # Older, richer people take the treatment more AND have higher outcomes (confounding).
        p = 1 / (1 + np.exp(-(-4 + 0.06 * age + 0.02 * income)))
        t = int(rng.random() < p)
        y = 10 + 0.3 * age + 0.2 * income + 5.0 * t + rng.normal(0, 3)
        rows.append({"treated": t, "outcome": float(y), "age": float(age), "income": float(income)})
    return upload_rows(client, rows, "obs"), rows


@pytest.mark.parametrize("method", ["matching", "ipw", "aipw"])
def test_propensity_recovers_effect_despite_confounding(client, observational, method):
    ds, rows = observational
    naive = np.mean([r["outcome"] for r in rows if r["treated"]]) - np.mean([r["outcome"] for r in rows if not r["treated"]])
    r = run(client, "causal.propensity", ds, treatment="treated", outcome="outcome", covariates=["age", "income"], method=method, bootstrap=60)
    assert abs(naive - 5) > 3  # the naive comparison is badly confounded
    assert r["effect"] == pytest.approx(5.0, abs=0.9), (method, r["effect"])
    assert r["ci"][0] < r["effect"] < r["ci"][1] and r["eValue"] > 1
    assert max(abs(b["after"]) for b in r["balance"]) < max(abs(b["before"]) for b in r["balance"])


def test_did_and_event_study(client):
    rng = np.random.default_rng(2)
    rows = []
    for unit in range(40):
        treated = int(unit < 20)
        base = rng.normal(100, 5)
        for t in range(8):
            y = base + 2 * t + (6.0 if treated and t >= 5 else 0) + rng.normal(0, 1)
            rows.append({"unit": f"u{unit}", "treated": treated, "t": t, "y": float(y)})
    ds = upload_rows(client, rows, "panel")
    r = run(client, "causal.did", ds, outcome="y", treated="treated", time="t", start=5, unit="unit")
    assert r["effect"] == pytest.approx(6.0, abs=0.6) and r["ci"][0] < 6 < r["ci"][1]
    assert r["preTrendsOk"] is True and r["eventStudy"]
    simple = run(client, "causal.did", ds, outcome="y", treated="treated", time="t", start=5)
    assert simple["effect"] == pytest.approx(6.0, abs=0.8)


def test_synthetic_control(client):
    rng = np.random.default_rng(4)
    rows = []
    trends = {f"s{i}": rng.normal(1, 0.3) for i in range(12)}
    for t in range(30):
        for u, slope in trends.items():
            rows.append({"store": u, "week": t, "sales": float(50 + slope * t + rng.normal(0, 0.5))})
        treated = 50 + (0.5 * trends["s1"] + 0.5 * trends["s2"]) * t + rng.normal(0, 0.5) + (8 if t >= 20 else 0)
        rows.append({"store": "target", "week": t, "sales": float(treated)})
    ds = upload_rows(client, rows, "stores")
    r = run(client, "causal.synthetic_control", ds, unit="store", time="week", outcome="sales", treated_unit="target", start=20, placebos=11)
    assert r["averageEffect"] == pytest.approx(8.0, abs=1.5) and r["preRmspe"] < 1.5 and r["placeboP"] <= 0.1


def test_iv_beats_biased_ols(client):
    rng = np.random.default_rng(5)
    rows = []
    for _ in range(4000):
        z = rng.normal()
        u = rng.normal()
        x = 0.8 * z + u + rng.normal(0, 0.5)
        y = 2.0 * x + 3 * u + rng.normal()
        rows.append({"y": float(y), "x": float(x), "z": float(z)})
    ds = upload_rows(client, rows, "iv")
    r = run(client, "causal.iv", ds, outcome="y", treatment="x", instruments=["z"])
    assert r["effect"] == pytest.approx(2.0, abs=0.25) and abs(r["olsEffect"] - 2.0) > 0.8
    assert r["firstStageF"] > 100 and not r["weakInstruments"] and r["wuHausman"]["p"] < 0.01


def test_rdd(client):
    rng = np.random.default_rng(6)
    rows = []
    for _ in range(3000):
        score = rng.uniform(0, 100)
        y = 20 + 0.4 * score + (7.0 if score >= 60 else 0) + rng.normal(0, 3)
        rows.append({"score": float(score), "y": float(y)})
    ds = upload_rows(client, rows, "rdd")
    r = run(client, "causal.rdd", ds, outcome="y", running="score", cutoff=60)
    assert r["jump"]["estimate"] == pytest.approx(7.0, abs=1.5) and r["density"]["p"] > 0.01


def test_uplift_finds_responders(client):
    rng = np.random.default_rng(8)
    rows = []
    for _ in range(4000):
        young = int(rng.random() < 0.5)
        t = int(rng.random() < 0.5)
        p = 0.1 + (0.25 if (t and young) else 0)
        rows.append({"treated": t, "bought": int(rng.random() < p), "young": young, "noise": float(rng.normal())})
    ds = upload_rows(client, rows, "uplift")
    r = run(client, "causal.uplift", ds, treatment="treated", outcome="bought", features=["young", "noise"])
    assert r["deciles"][0]["observedUplift"] > r["deciles"][-1]["observedUplift"] + 0.1 and r["qiniCoefficient"] > 0


def test_ab_test_cuped_srm(client):
    rng = np.random.default_rng(9)
    rows = []
    for i in range(6000):
        v = "B" if i % 2 else "A"
        pre = rng.normal(100, 20)
        rev = 0.9 * pre + (2.0 if v == "B" else 0) + rng.normal(0, 5)
        rows.append({"variant": v, "revenue": float(rev), "pre_revenue": float(pre), "converted": int(rng.random() < (0.12 if v == "B" else 0.10))})
    ds = upload_rows(client, rows, "ab")
    plain = run(client, "exp.ab_test", ds, variant="variant", metric="revenue")
    cuped = run(client, "exp.ab_test", ds, variant="variant", metric="revenue", covariate="pre_revenue")
    b_plain, b_cuped = plain["variants"][1], cuped["variants"][1]
    assert cuped["cuped"]["varianceReduction"] > 0.5
    assert (b_cuped["ci"][1] - b_cuped["ci"][0]) < (b_plain["ci"][1] - b_plain["ci"][0]) / 2
    assert b_cuped["difference"] == pytest.approx(2.0, abs=0.4) and b_cuped["significant"]
    conv = run(client, "exp.ab_test", ds, variant="variant", metric="converted")
    assert conv["kind"] == "conversion" and conv["sampleRatio"]["mismatch"] is False
    bad = run(client, "exp.srm", observed=[5200, 4800])
    assert bad["mismatch"] is True


def test_sequential_matches_obrien_fleming(client):
    r = run(client, "exp.sequential", looks=5, alpha=0.05, observed_z=[1.0, 2.2, 3.0])
    b = [x["boundaryZ"] for x in r["plan"]]
    # Lan–DeMets O'Brien–Fleming boundaries for 5 equally spaced looks, two-sided α = 0.05.
    assert b == pytest.approx([4.877, 3.357, 2.680, 2.290, 2.031], abs=0.06)
    assert r["decision"]["stop"] is True and r["decision"]["atLook"] == 3


def test_sample_size_and_bandit(client):
    s = run(client, "exp.sample_size", baseline=0.10, mde=0.10, daily_traffic=2000)
    assert 14000 < s["perVariant"] < 15500 and s["days"] > 0
    b = run(client, "exp.bandit", arms=[{"name": "A", "successes": 50, "trials": 1000}, {"name": "B", "successes": 80, "trials": 1000}])
    assert b["arms"][1]["probabilityBest"] > 0.99
