"""Engine v2 against published reference results (R, textbooks), not just self-consistency."""
import pytest
from conftest import run, upload_rows


def test_glm_poisson_matches_r_dobson(client):
    # R: example(glm) — Dobson (1990) p. 93, glm(counts ~ outcome + treatment, family = poisson()).
    counts = [18, 17, 15, 20, 10, 20, 25, 13, 12]
    rows = [{"counts": c, "outcome": i % 3 + 1, "treatment": i // 3 + 1} for i, c in enumerate(counts)]
    ds = upload_rows(client, rows, "dobson")
    r = run(client, "stats.glm", ds, outcome="counts", predictors=["outcome", "treatment"], family="poisson", categorical=["outcome", "treatment"])
    coef = {c["term"]: c for c in r["coefficients"]}

    def term(*bits):
        return next(v for k, v in coef.items() if all(b in k for b in bits))

    assert term("Intercept")["estimate"] == pytest.approx(3.045, abs=5e-4)
    assert term("outcome", "2")["estimate"] == pytest.approx(-0.4543, abs=5e-4)
    assert term("outcome", "2")["se"] == pytest.approx(0.2022, abs=5e-4)
    assert term("outcome", "3")["estimate"] == pytest.approx(-0.2930, abs=5e-4)
    assert abs(term("treatment", "2")["estimate"]) < 1e-8 and abs(term("treatment", "3")["estimate"]) < 1e-8
    assert r["fit"]["deviance"] == pytest.approx(5.129, abs=5e-4)
    assert r["fit"]["nullDeviance"] == pytest.approx(10.58, abs=5e-3)
    assert r["fit"]["aic"] == pytest.approx(56.76, abs=5e-3)
    assert r["fit"]["dfResid"] == 4


GEHAN_6MP = [(6, 1), (6, 1), (6, 1), (6, 0), (7, 1), (9, 0), (10, 1), (10, 0), (11, 0), (13, 1), (16, 1), (17, 0), (19, 0), (20, 0),
             (22, 1), (23, 1), (25, 0), (32, 0), (32, 0), (34, 0), (35, 0)]
GEHAN_CONTROL = [(t, 1) for t in (1, 1, 2, 2, 3, 4, 4, 5, 5, 8, 8, 8, 8, 11, 11, 12, 12, 15, 17, 22, 23)]


@pytest.fixture(scope="module")
def gehan(client):
    rows = [{"weeks": t, "relapse": e, "treat": "6-MP"} for t, e in GEHAN_6MP] + [{"weeks": t, "relapse": e, "treat": "control"} for t, e in GEHAN_CONTROL]
    return upload_rows(client, rows, "gehan")


def test_kaplan_meier_and_logrank_match_gehan(client, gehan):
    # Freireich et al. (1963) / Gehan (1965) leukaemia remission data; R: survfit / survdiff on MASS::gehan.
    r = run(client, "survival.kaplan_meier", gehan, duration="weeks", event="relapse", group="treat", at_times=[6, 7, 10, 13, 16, 22, 23])
    mp = next(c for c in r["curves"] if c["group"] == "6-MP")
    at = {a["t"]: a["s"] for a in mp["at"]}
    for t, s in {6: 0.857, 7: 0.807, 10: 0.753, 13: 0.690, 16: 0.627, 22: 0.538, 23: 0.448}.items():
        assert at[t] == pytest.approx(s, abs=5e-4)
    assert mp["median"] == 23
    control = next(c for c in r["curves"] if c["group"] == "control")
    assert control["median"] == 8
    assert r["logRank"]["statistic"] == pytest.approx(16.79, abs=0.01)


def test_cox_matches_r_coxph_gehan(client, gehan):
    # R: coxph(Surv(time, cens) ~ treat, data = MASS::gehan) — coef 1.572 (se 0.412) for control vs 6-MP, Efron ties.
    rows = [{"weeks": t, "relapse": e, "control": 0} for t, e in GEHAN_6MP] + [{"weeks": t, "relapse": e, "control": 1} for t, e in GEHAN_CONTROL]
    ds = upload_rows(client, rows, "gehan01")
    r = run(client, "survival.regression", ds, duration="weeks", event="relapse", covariates=["control"])
    c = next(x for x in r["coefficients"] if x["term"] == "control")
    assert c["coef"] == pytest.approx(1.572, abs=1e-3)
    assert c["hazardRatio"] == pytest.approx(4.817, abs=5e-3)
