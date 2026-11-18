"""Engine v2, phase 2: statistics, Bayesian and survival — checked against scipy/statsmodels
and against data with known true effects."""
import numpy as np
import pytest
from scipy import stats

from conftest import run, upload_rows


@pytest.fixture(scope="module")
def trial(client):
    rng = np.random.default_rng(1)
    rows = []
    for i in range(600):
        arm = ["control", "drug_a", "drug_b"][i % 3]
        sex = "F" if i % 2 else "M"
        age = float(rng.integers(20, 80))
        effect = {"control": 0.0, "drug_a": 2.0, "drug_b": 3.5}[arm]
        bp = 120 + effect * -1 + 0.3 * age + (2 if sex == "M" else 0) + rng.normal(0, 4)
        visits = int(rng.poisson(np.exp(0.5 + 0.02 * age)))
        clinic = f"c{i % 12}"
        rows.append({"arm": arm, "sex": sex, "age": age, "bp": float(bp), "bp_after": float(bp - effect - rng.normal(0, 1)),
                     "visits": visits, "clinic": clinic, "recovered": int(rng.random() < 1 / (1 + np.exp(-(-3 + 0.05 * age)))),
                     "score": float(rng.normal(50 + (5 if clinic in ("c0", "c1", "c2") else 0), 3))})
    return upload_rows(client, rows, "trial"), rows


def test_compare_two_groups_matches_scipy(client, trial):
    ds, rows = trial
    two = [r for r in rows if r["arm"] in ("control", "drug_b")]
    ds2 = upload_rows(client, two, "two")
    r = run(client, "stats.compare", ds2, a="bp", b="arm")
    a = [x["bp"] for x in two if x["arm"] == "control"]
    b = [x["bp"] for x in two if x["arm"] == "drug_b"]
    t_ref = stats.ttest_ind(a, b, equal_var=r["assumptions"]["levene"]["equalVariances"]).pvalue
    u_ref = stats.mannwhitneyu(a, b).pvalue
    assert r["kind"] == "two_groups"
    # Whichever test the engine chose, both p-values must match scipy exactly.
    ps = {r["chosen"]["test"]: r["chosen"]["p"], r["alternative"]["test"]: r["alternative"]["p"]}
    assert ps["Mann–Whitney U"] == pytest.approx(u_ref, rel=1e-9)
    assert [v for k, v in ps.items() if "t-test" in k][0] == pytest.approx(t_ref, rel=1e-9)
    assert r["effect"]["cohen_d"] is not None and r["ciBootstrap"][0] < r["meanDifference"] < r["ciBootstrap"][1]


def test_compare_many_groups_categorical_correlation_paired(client, trial):
    ds, rows = trial
    m = run(client, "stats.compare", ds, a="bp", b="arm")
    assert m["kind"] == "many_groups" and m["posthoc"]["pairs"] and m["significant"]
    c = run(client, "stats.compare", ds, a="sex", b="arm")
    assert c["kind"] == "categorical" and c["chosen"]["p"] > 0.05
    cor = run(client, "stats.compare", ds, a="bp", b="age")
    assert cor["kind"] == "correlation" and cor["pearson"]["r"] > 0.3
    pr = run(client, "stats.compare", ds, a="bp", b="bp_after", paired=True)
    assert pr["kind"] == "paired" and pr["meanDifference"] > 0


def test_correlation_matrix_and_normality_and_nonparametric(client, trial):
    ds, _ = trial
    cm = run(client, "stats.correlation_matrix", ds, columns=["bp", "age", "score"], method="spearman")
    assert len(cm["pairs"]) == 3 and all("pAdjusted" in p for p in cm["pairs"])
    part = run(client, "stats.correlation_matrix", ds, columns=["bp", "bp_after"], partial_on=["age"])
    assert part["pairs"][0]["r"] > 0.5
    n = run(client, "stats.normality", ds, column="score")
    assert len(n["tests"]) == 4 and len(n["qq"]) == 100
    pm = run(client, "stats.nonparametric", ds, test="permutation", columns=["bp"], group="sex", permutations=999)
    assert 0 <= pm["p"] <= 1
    kw = run(client, "stats.nonparametric", ds, test="kruskal", columns=["bp"], group="arm")
    assert kw["p"] < 0.05


def test_multiple_testing_matches_statsmodels(client):
    from statsmodels.stats.multitest import multipletests
    ps = [0.01, 0.04, 0.03, 0.2]
    r = run(client, "stats.multiple_testing", p_values=ps, method="fdr_bh")
    assert [x["pAdjusted"] for x in r["results"]] == pytest.approx(list(multipletests(ps, method="fdr_bh")[1]))


def test_glm_recovers_known_effects(client, trial):
    ds, _ = trial
    g = run(client, "stats.glm", ds, outcome="bp", predictors=["age", "sex", "arm"])
    coef = {c["term"]: c["estimate"] for c in g["coefficients"]}
    assert coef["age"] == pytest.approx(0.3, abs=0.05)
    assert coef["arm = drug_b"] == pytest.approx(-3.5, abs=1.2)
    assert g["vif"] and g["diagnostics"]["r2"] > 0.5
    pois = run(client, "stats.glm", ds, outcome="visits", predictors=["age"], family="poisson")
    pc = {c["term"]: c for c in pois["coefficients"]}
    assert pc["age"]["estimate"] == pytest.approx(0.02, abs=0.006) and pc["age"]["expEstimate"] > 1
    logit = run(client, "stats.glm", ds, outcome="recovered", predictors=["age"], family="binomial", robust="hc3")
    assert {c["term"]: c for c in logit["coefficients"]}["age"]["estimate"] == pytest.approx(0.05, abs=0.025)


def test_anova_mixed_robust_quantile(client, trial):
    ds, _ = trial
    a = run(client, "stats.anova", ds, outcome="bp", factors=["arm", "sex"], covariates=["age"])
    terms = {t["term"]: t for t in a["table"]}
    assert terms["arm"]["p"] < 0.001 and "age" in terms and a["posthoc"]["arm"]
    mx = run(client, "stats.mixed", ds, outcome="score", group="clinic")
    assert mx["icc"] > 0.2 and mx["groups"] == 12
    rb = run(client, "stats.robust_regression", ds, outcome="bp", predictors=["age"], method="huber")
    assert rb["coefficients"][1]["estimate"] == pytest.approx(0.3, abs=0.06)
    qr = run(client, "stats.robust_regression", ds, outcome="bp", predictors=["age"], method="quantile", quantiles=[0.25, 0.5, 0.75])
    assert len(qr["fits"]) == 3


def test_bootstrap_and_power(client, trial):
    ds, rows = trial
    b = run(client, "stats.bootstrap", ds, statistic="mean", column="bp", resamples=1000)
    assert b["ci"][0] < np.mean([r["bp"] for r in rows]) < b["ci"][1]
    d = run(client, "stats.bootstrap", ds, statistic="mean_difference", column="bp", other="sex", resamples=500, method="percentile")
    assert d["ci"][0] < d["estimate"] < d["ci"][1]
    pw = run(client, "stats.power", test="t_two_sample", effect_size=0.5, power=0.8)
    assert pw["result"]["n"] == pytest.approx(63.77, abs=0.1) and pw["nRoundedUp"] == 64
    pr = run(client, "stats.power", test="correlation", effect_size=0.3, power=0.8)
    assert pr["result"]["n"] == pytest.approx(84.9, abs=1.5)


def test_bayes_ab_from_counts_and_data(client, trial):
    r = run(client, "bayes.ab_test", groups=[{"name": "A", "successes": 100, "trials": 1000}, {"name": "B", "successes": 140, "trials": 1000}])
    assert r["leader"] == "B" and r["leaderProbability"] > 0.99
    lift = r["variants"][1]["liftOverBaseline"]
    assert lift["credible"][0] > 0
    ds, _ = trial
    d = run(client, "bayes.ab_test", ds, variant="sex", metric="recovered")
    assert d["kind"] == "conversion" and len(d["variants"]) == 2


def test_bayes_ttest_and_regression(client, trial):
    ds, rows = trial
    two = upload_rows(client, [r for r in rows if r["arm"] in ("control", "drug_b")], "two-b")
    strong = run(client, "bayes.ttest", two, value="bp_after", group="arm")
    assert strong["bf10"] > 3
    null = run(client, "bayes.ttest", ds, value="score", group="sex")
    assert null["bf10"] < 1
    # Reference: JZS one-sample t=2.03, n=80, r=1 gives BF01 ≈ 1.56 (Rouder et al., 2009, p. 232).
    from engine.capabilities.bayes_survival import jzs_bf10
    assert 1 / jzs_bf10(2.03, 80, None, 1.0) == pytest.approx(1.56, abs=0.05)
    br = run(client, "bayes.regression", ds, outcome="bp", predictors=["age", "sex"])
    age = next(c for c in br["coefficients"] if c["term"] == "age")
    assert age["probabilityPositive"] > 0.999 and age["bf10"] > 100


@pytest.fixture(scope="module")
def churn(client):
    rng = np.random.default_rng(3)
    rows = []
    for i in range(500):
        plan = "basic" if i % 2 else "premium"
        hazard = 0.05 * (2.0 if plan == "basic" else 1.0)
        t = rng.exponential(1 / hazard)
        censor = rng.uniform(5, 40)
        rows.append({"months": float(min(t, censor)), "churned": int(t <= censor), "plan": plan, "age": float(rng.integers(18, 70))})
    return upload_rows(client, rows, "churn")


def test_kaplan_meier_and_logrank(client, churn):
    r = run(client, "survival.kaplan_meier", churn, duration="months", event="churned", group="plan", at_times=[6, 12])
    meds = {c["group"]: c["median"] for c in r["curves"]}
    assert meds["basic"] < meds["premium"] and r["logRank"]["p"] < 0.001
    assert all(0 <= pt["s"] <= 1 for c in r["curves"] for pt in c["curve"])


def test_cox_recovers_hazard_ratio_and_aft(client, churn):
    r = run(client, "survival.regression", churn, duration="months", event="churned", covariates=["plan", "age"])
    hr = next(c for c in r["coefficients"] if "plan" in c["term"])
    # premium vs basic: true hazard ratio 0.5
    assert hr["hazardRatio"] == pytest.approx(0.5, abs=0.15) and r["concordance"] > 0.55
    aft = run(client, "survival.regression", churn, duration="months", event="churned", covariates=["plan"], model="weibull_aft")
    assert aft["coefficients"] and aft["model"] == "weibull_aft"
