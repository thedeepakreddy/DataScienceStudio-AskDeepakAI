"""Reports from recorded runs: a methods section (with references) written from a
run's manifest and result, and a Jupyter notebook that reproduces the run."""
from __future__ import annotations

import json
from typing import Any

from .registry import REGISTRY

# What each capability does, in methods-section prose, and the papers behind it.
METHODS: dict[str, tuple[str, list[str]]] = {
    "data.profile": ("Each column was profiled (types, missing values, distinct values, distribution statistics, histograms and frequent values) with DuckDB over all rows.", []),
    "data.estimate": ("The statistic was estimated from a simple random sample with a finite-population-corrected confidence interval and compared with its exact value.", ["Cochran, W. G. (1977). Sampling Techniques (3rd ed.). Wiley."]),
    "data.validate": ("The data were checked against declarative validation rules; failing rows were counted and sampled per rule.", []),
    "data.outliers": ("Outliers were flagged with the chosen detector (interquartile range, z-score, median absolute deviation, isolation forest or local outlier factor).", ["Liu, F. T., Ting, K. M., & Zhou, Z.-H. (2008). Isolation forest. ICDM.", "Breunig, M. M., et al. (2000). LOF: identifying density-based local outliers. SIGMOD."]),
    "data.pii_scan": ("Columns were scanned for personal data with pattern matching (with Luhn validation for card numbers) and column-name hints.", []),
    "data.pii_mask": ("Personal data were masked by salted hashing, redaction, partial masking, generalisation or removal.", []),
    "data.recipe": ("The data were transformed by a recorded, ordered recipe of steps compiled to a single SQL query and executed with DuckDB.", []),
    "stats.compare": ("The test was chosen from the data: assumptions (normality by Shapiro–Wilk, equal variances by Levene's test) decided between parametric and rank-based tests, effect sizes were reported with confidence intervals, and post-hoc comparisons were adjusted for multiplicity.", ["Welch, B. L. (1947). The generalization of Student's problem. Biometrika, 34, 28–35.", "Mann, H. B., & Whitney, D. R. (1947). Annals of Mathematical Statistics, 18, 50–60."]),
    "stats.correlation_matrix": ("Pairwise correlations (and partial correlations where requested) were computed with p-values adjusted for multiple testing.", ["Benjamini, Y., & Hochberg, Y. (1995). Controlling the false discovery rate. JRSS B, 57, 289–300."]),
    "stats.normality": ("Normality was assessed with the Shapiro–Wilk, D'Agostino–Pearson, Jarque–Bera and Anderson–Darling tests together with skewness and kurtosis.", ["Shapiro, S. S., & Wilk, M. B. (1965). Biometrika, 52, 591–611."]),
    "stats.nonparametric": ("A rank-based test suited to the design was used.", []),
    "stats.multiple_testing": ("p-values were adjusted for multiple comparisons.", ["Holm, S. (1979). Scandinavian Journal of Statistics, 6, 65–70.", "Benjamini, Y., & Hochberg, Y. (1995). JRSS B, 57, 289–300."]),
    "stats.glm": ("A generalised linear model was fitted by maximum likelihood (statsmodels), with heteroscedasticity-robust (HC3) or cluster-robust standard errors where requested, and diagnostics for multicollinearity (VIF), influence (Cook's distance), heteroscedasticity (Breusch–Pagan) and overdispersion.", ["McCullagh, P., & Nelder, J. A. (1989). Generalized Linear Models (2nd ed.). Chapman & Hall.", "MacKinnon, J. G., & White, H. (1985). Journal of Econometrics, 29, 305–325."]),
    "stats.anova": ("Analysis of variance was carried out with the chosen sums of squares, effect sizes (η², partial η², ω²) and Tukey HSD post-hoc comparisons.", ["Tukey, J. W. (1949). Biometrics, 5, 99–114."]),
    "stats.mixed": ("A linear mixed-effects model was fitted by restricted maximum likelihood with random intercepts (and slopes where specified) for the grouping factor.", ["Laird, N. M., & Ware, J. H. (1982). Biometrics, 38, 963–974."]),
    "stats.robust_regression": ("A robust regression (Huber or Tukey biweight M-estimation, or quantile regression) was fitted to limit the influence of outliers.", ["Huber, P. J. (1964). Annals of Mathematical Statistics, 35, 73–101.", "Koenker, R., & Bassett, G. (1978). Econometrica, 46, 33–50."]),
    "stats.bootstrap": ("Confidence intervals were obtained by nonparametric bootstrap resampling (percentile and bias-corrected and accelerated intervals).", ["Efron, B., & Tibshirani, R. J. (1993). An Introduction to the Bootstrap. Chapman & Hall."]),
    "stats.power": ("Statistical power and sample sizes were computed analytically for the design.", ["Cohen, J. (1988). Statistical Power Analysis for the Behavioral Sciences (2nd ed.)."]),
    "bayes.ab_test": ("Conversion rates (Beta–Binomial) or means were compared with Bayesian posteriors estimated by Monte Carlo, reporting the probability that each variant is best and the expected loss.", ["Gelman, A., et al. (2013). Bayesian Data Analysis (3rd ed.). CRC Press."]),
    "bayes.ttest": ("A Bayesian t-test with the JZS (Cauchy) prior on the standardised effect size gave the Bayes factor.", ["Rouder, J. N., et al. (2009). Bayesian t tests for accepting and rejecting the null hypothesis. Psychonomic Bulletin & Review, 16, 225–237."]),
    "bayes.regression": ("A Bayesian linear regression with the Jeffreys prior gave posterior intervals, and BIC-approximated Bayes factors compared predictors.", ["Kass, R. E., & Raftery, A. E. (1995). Bayes factors. JASA, 90, 773–795."]),
    "survival.kaplan_meier": ("Survival curves were estimated with the Kaplan–Meier estimator and compared with the log-rank test.", ["Kaplan, E. L., & Meier, P. (1958). JASA, 53, 457–481."]),
    "survival.regression": ("Time-to-event outcomes were modelled with a Cox proportional-hazards or accelerated failure time model (lifelines), with a check of the proportional-hazards assumption.", ["Cox, D. R. (1972). JRSS B, 34, 187–220."]),
    "causal.propensity": ("The treatment effect was estimated from observational data with propensity scores (matching, inverse probability weighting or augmented IPW), covariate balance was checked with standardised mean differences, intervals came from the bootstrap, and sensitivity to unmeasured confounding was summarised with the E-value.", ["Rosenbaum, P. R., & Rubin, D. B. (1983). Biometrika, 70, 41–55.", "VanderWeele, T. J., & Ding, P. (2017). Annals of Internal Medicine, 167, 268–274."]),
    "causal.did": ("A difference-in-differences regression with cluster-robust standard errors (and an event-study specification to check pre-trends) estimated the effect.", ["Angrist, J. D., & Pischke, J.-S. (2009). Mostly Harmless Econometrics. Princeton."]),
    "causal.synthetic_control": ("A synthetic control built from a weighted combination of untreated units estimated the effect, with a placebo-in-space permutation test.", ["Abadie, A., Diamond, A., & Hainmueller, J. (2010). JASA, 105, 493–505."]),
    "causal.iv": ("Two-stage least squares with the given instruments estimated the effect, with first-stage strength (F), endogeneity (Wu–Hausman) and over-identification (Sargan) tests.", ["Stock, J. H., & Yogo, M. (2005). Testing for weak instruments. In Identification and Inference for Econometric Models."]),
    "causal.rdd": ("A regression discontinuity design estimated the effect at the cutoff with local linear regression.", ["Imbens, G., & Lemieux, T. (2008). Journal of Econometrics, 142, 615–635."]),
    "causal.uplift": ("Heterogeneous treatment effects were estimated with a two-model (T-learner) approach and evaluated by uplift deciles and the Qini curve.", ["Künzel, S. R., et al. (2019). PNAS, 116, 4156–4165."]),
    "exp.ab_test": ("The experiment was analysed with z-tests for proportions or Welch t-tests for means, with variance reduction by CUPED where a pre-period covariate was given, a sample-ratio-mismatch check, and Holm adjustment across variants.", ["Deng, A., et al. (2013). Improving the sensitivity of online controlled experiments (CUPED). WSDM."]),
    "exp.sequential": ("Group-sequential boundaries were derived with Lan–DeMets alpha-spending.", ["Lan, K. K. G., & DeMets, D. L. (1983). Biometrika, 70, 659–663."]),
    "exp.srm": ("Sample ratio mismatch was tested with a chi-square goodness-of-fit test.", ["Fabijan, A., et al. (2019). Diagnosing sample ratio mismatch. KDD."]),
    "exp.sample_size": ("Sample sizes were computed for the minimum detectable effect, significance level and power.", []),
    "exp.bandit": ("Traffic allocation was computed with Thompson sampling.", ["Thompson, W. R. (1933). Biometrika, 25, 285–294."]),
    "ml.automl": ("Candidate model families were tuned with Optuna (TPE) under cross-validation on the training split, a stacked ensemble of the best was added, and the champion was chosen by cross-validated score with Nadeau–Bengio corrected confidence intervals and a corrected resampled t-test against the runner-up. Performance was reported on a held-out test split (and, when chosen, a separate validation split); uncertainty was quantified by split-conformal prediction.", ["Akiba, T., et al. (2019). Optuna. KDD.", "Nadeau, C., & Bengio, Y. (2003). Inference for the generalization error. Machine Learning, 52, 239–281.", "Angelopoulos, A. N., & Bates, S. (2023). Conformal prediction: a gentle introduction. Foundations and Trends in ML."]),
    "ml.predict": ("Predictions were produced in batches with the saved model, with conformal intervals or sets.", []),
    "ml.explain": ("Predictions were explained with SHAP values (TreeExplainer for tree ensembles, otherwise a permutation explainer), partial dependence and ICE curves, and a global surrogate tree.", ["Lundberg, S. M., & Lee, S.-I. (2017). A unified approach to interpreting model predictions. NeurIPS."]),
    "ml.fairness": ("Group fairness was assessed by demographic parity difference, disparate impact ratio (four-fifths rule) and equalised odds difference.", ["Hardt, M., Price, E., & Srebro, N. (2016). Equality of opportunity in supervised learning. NeurIPS."]),
    "ml.feature_selection": ("Features were ranked by mutual information, F-tests and random-forest importance, with Boruta shadow features and a redundancy check.", ["Kursa, M. B., & Rudnicki, W. R. (2010). Journal of Statistical Software, 36(11)."]),
    "ts.forecast": ("Forecasting models (naive, seasonal naive, drift, ETS selected by AICc, seasonal ARIMA selected by AIC, Theta and a gradient-boosted lag model) were compared by rolling-origin backtests scored with MASE, and the best model or an equal-weight ensemble of the top three was refitted on the full series.", ["Hyndman, R. J., & Koehler, A. B. (2006). Another look at measures of forecast accuracy. IJF, 22, 679–688.", "Hyndman, R. J., & Athanasopoulos, G. (2021). Forecasting: Principles and Practice (3rd ed.)."]),
    "ts.decompose": ("The series was decomposed by STL, with strengths of trend and seasonality, autocorrelation functions and ADF and KPSS stationarity tests.", ["Cleveland, R. B., et al. (1990). STL. Journal of Official Statistics, 6, 3–73."]),
    "ts.anomalies": ("Anomalies were flagged where the STL remainder exceeded a robust z-score threshold, refitting the decomposition with flagged points masked.", ["Cleveland, R. B., et al. (1990). Journal of Official Statistics, 6, 3–73."]),
    "ts.changepoints": ("Change points in the mean were located by the exact PELT algorithm with a BIC-style penalty.", ["Killick, R., Fearnhead, P., & Eckley, I. A. (2012). JASA, 107, 1590–1598."]),
    "ts.hierarchical": ("Base ETS forecasts at every level of the hierarchy were reconciled by OLS so that they add up.", ["Hyndman, R. J., et al. (2011). Optimal combination forecasts for hierarchical time series. CSDA, 55, 2579–2589."]),
    "unsup.cluster": ("Rows were clustered on standardised features; the number of clusters was chosen by silhouette (or BIC for Gaussian mixtures), and clusters were described by their most distinctive features.", ["Rousseeuw, P. J. (1987). Silhouettes. Journal of Computational and Applied Mathematics, 20, 53–65.", "Campello, R. J. G. B., et al. (2013). HDBSCAN. PAKDD."]),
    "unsup.embed": ("The data were projected to low dimensions by PCA, UMAP or t-SNE.", ["McInnes, L., Healy, J., & Melville, J. (2018). UMAP. arXiv:1802.03426."]),
    "unsup.association_rules": ("Frequent itemsets and association rules were mined with the Apriori algorithm.", ["Agrawal, R., & Srikant, R. (1994). Fast algorithms for mining association rules. VLDB."]),
    "text.analyze": ("Sentiment was scored with VADER, keywords by TF-IDF, and topics by non-negative matrix factorisation.", ["Hutto, C., & Gilbert, E. (2014). VADER. ICWSM."]),
    "text.embed": ("Texts were embedded with a pretrained sentence-transformer (mean-pooled, L2-normalised token embeddings) run in ONNX Runtime, and mapped to two dimensions with UMAP.", ["Reimers, N., & Gurevych, I. (2019). Sentence-BERT. EMNLP.", "Wang, W., et al. (2020). MiniLM. NeurIPS."]),
    "text.semantic_search": ("Semantic similarity was measured as the cosine similarity of sentence-transformer embeddings; near-duplicates were pairs above the threshold, grouped by connected components.", ["Reimers, N., & Gurevych, I. (2019). Sentence-BERT. EMNLP."]),
    "text.sentiment": ("Sentiment was classified as negative, neutral or positive with a pretrained RoBERTa model (Cardiff NLP twitter-roberta-base-sentiment-latest, CC BY 4.0).", ["Loureiro, D., et al. (2022). TimeLMs: Diachronic language models from Twitter. ACL demo.", "Liu, Y., et al. (2019). RoBERTa. arXiv:1907.11692."]),
    "text.zero_shot": ("Texts were assigned to the given categories without training data by natural-language inference: each label was turned into a hypothesis and scored for entailment with a DeBERTa-v3 cross-encoder.", ["Yin, W., Hay, J., & Roth, D. (2019). Benchmarking zero-shot text classification. EMNLP.", "He, P., et al. (2021). DeBERTaV3. arXiv:2111.09543."]),
    "text.entities": ("Named entities (people, organisations, locations, miscellaneous) were extracted with a BERT model fine-tuned on CoNLL-2003, merging token tags into spans.", ["Tjong Kim Sang, E. F., & De Meulder, F. (2003). CoNLL-2003 shared task. CoNLL.", "Devlin, J., et al. (2019). BERT. NAACL."]),
    "text.semantic_topics": ("Topics were found by embedding texts with a sentence-transformer, reducing the embeddings with UMAP and clustering with HDBSCAN; each topic was described by class-based TF-IDF.", ["Grootendorst, M. (2022). BERTopic. arXiv:2203.05794.", "McInnes, L., et al. (2018). UMAP. arXiv:1802.03426."]),
    "text.similarity": ("Text similarity was measured by cosine similarity of TF-IDF vectors.", []),
    "opt.monte_carlo": ("The outcome distribution was estimated by Monte Carlo simulation of the uncertain inputs; sensitivity was measured by Spearman rank correlation.", []),
    "opt.linear_program": ("The optimisation problem was solved with the HiGHS solver; shadow prices come from the dual of the linear relaxation.", ["Huangfu, Q., & Hall, J. A. J. (2018). Parallelizing the dual revised simplex method. Mathematical Programming Computation, 10, 119–142."]),
    "opt.scenarios": ("What-if scenarios were scored with the saved model over a grid of input values.", []),
    "mlops.retrain_if_drift": ("The model was checked for drift (population stability index, Kolmogorov–Smirnov and chi-square tests) and performance decay on new data; when the status reached the chosen level it was retrained with its original AutoML settings, and the new version was promoted only if it outperformed the current model on the new data.", ["Gama, J., et al. (2014). A survey on concept drift adaptation. ACM Computing Surveys, 46(4)."]),
    "mlops.monitor": ("Drift was measured with the population stability index over training deciles, Kolmogorov–Smirnov and chi-square tests, and performance against held-out test metrics.", ["Yurdakul, B. (2018). Statistical properties of population stability index. Western Michigan University."]),
}


def _detail(cap: str, result: dict[str, Any]) -> str:
    """One sentence on what the run found, where the result says it plainly."""
    try:
        if cap == "stats.compare" and result.get("chosen"):
            c = result["chosen"]
            return f"The test applied was the {c['test']} (p = {c['p']:.3g})." if c.get("p") is not None else f"The test applied was the {c['test']}."
        if cap == "ml.automl" and result.get("champion"):
            ch = result["champion"]
            return f"The champion was {ch['label']} (cross-validated {result.get('scoring', 'score')} {ch['cvMean']:.3f})."
        if cap == "ts.forecast" and result.get("best"):
            return f"The selected forecaster was {result['best']} over {result.get('backtestWindows')} backtest windows."
        if cap == "unsup.cluster" and result.get("k"):
            return f"{result['k']} clusters were found."
        if cap == "mlops.monitor" and result.get("summary"):
            s = result["summary"]
            return f"{s['featuresDrifted']} of {s['featuresChecked']} features had drifted; overall status: {s['status']}."
    except (KeyError, TypeError, ValueError):
        return ""
    return ""


def methods(run: dict[str, Any], result: dict[str, Any] | None) -> dict[str, Any]:
    cap = run["capability"]
    man = (result or {}).get("manifest") or {}
    text, refs = METHODS.get(cap, (REGISTRY[cap].summary if cap in REGISTRY else f"The {cap} analysis was run.", []))
    libs = man.get("libraries") or {}
    used = ", ".join(f"{k} {v}" for k, v in libs.items())
    ds = run.get("dataset") or {}
    parts = []
    if ds:
        rows = man.get("dataset", {}).get("rows")
        parts.append(f"The analysis used the dataset “{ds.get('name')}” ({f'{rows:,} rows, ' if rows else ''}content fingerprint {str(ds.get('fingerprint'))[:12]}).")
    parts.append(text)
    detail = _detail(cap, result or {})
    if detail:
        parts.append(detail)
    parts.append(f"It was computed with AskDeepakAI Engine {man.get('engineVersion', '2')} on Python {man.get('python', '3')} ({used}) "
                 f"with random seed {run['seed']}; the full parameters have fingerprint {run['paramsFingerprint'][:12]}, so re-running with the "
                 "same data, parameters and seed reproduces the result.")
    for note in (result or {}).get("notes", [])[:5]:
        parts.append(f"Note: {note}")
    paragraph = " ".join(parts)
    md = "## Methods\n\n" + paragraph + ("\n\n### References\n\n" + "\n".join(f"- {r}" for r in refs) if refs else "") + "\n"
    return {"runId": run["id"], "capability": cap, "text": paragraph, "references": refs, "markdown": md}


def notebook(run: dict[str, Any], result: dict[str, Any] | None, engine_url: str = "http://localhost:8000") -> dict[str, Any]:
    """A notebook that re-runs the analysis through the engine API and checks it matches."""
    man = (result or {}).get("manifest") or {}
    ds = run.get("dataset") or {}
    meth = methods(run, result)

    def md(src: str) -> dict[str, Any]:
        return {"cell_type": "markdown", "metadata": {}, "source": src.splitlines(keepends=True)}

    def code(src: str) -> dict[str, Any]:
        return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": src.splitlines(keepends=True)}

    cells = [
        md(f"# Reproduce run `{run['id']}`: {REGISTRY[run['capability']].title if run['capability'] in REGISTRY else run['capability']}\n\n"
           f"Recorded {run.get('startedAt')} · engine {man.get('engineVersion')} · seed {run['seed']}.\n\n"
           "This notebook sends the same request to an AskDeepakAI engine and checks that the answer matches the recorded one."),
        code("import json, os, requests\n\n"
             f"ENGINE = os.environ.get('ENGINE_URL', {engine_url!r})\n"
             "HEADERS = {'X-Engine-Token': os.environ['ENGINE_TOKEN']} if os.environ.get('ENGINE_TOKEN') else {}\n"
             "print(requests.get(f'{ENGINE}/v2/info', headers=HEADERS, timeout=30).json()['libraries'])"),
    ]
    if ds:
        cells += [
            md(f"## Data\n\nThe run used dataset **{ds.get('name')}** (`{ds.get('id')}`). Its id is a fingerprint of its content, "
               "so uploading the same file again gives the same id. Set `DATA_FILE` to upload it if the engine doesn't have it."),
            code(f"DATASET_ID = {ds.get('id')!r}\nDATA_FILE = None  # e.g. 'data.csv'\n\n"
                 "r = requests.get(f'{ENGINE}/v2/datasets/{DATASET_ID}', headers=HEADERS, timeout=30)\n"
                 "if r.status_code == 404 and DATA_FILE:\n"
                 "    with open(DATA_FILE, 'rb') as f:\n"
                 "        up = requests.post(f'{ENGINE}/v2/datasets/upload', files={'file': f}, headers=HEADERS, timeout=600).json()\n"
                 "    assert up['id'] == DATASET_ID, 'This file has different content from the original.'\n"
                 "    r = requests.get(f'{ENGINE}/v2/datasets/{DATASET_ID}', headers=HEADERS, timeout=30)\n"
                 "r.raise_for_status()\nprint(r.json()['rows'], 'rows')"),
        ]
    cells += [
        md("## Run\n\nThe exact parameters and seed from the recorded run (secrets are never recorded, so add any passwords again)."),
        code(f"PARAMS = json.loads({json.dumps(json.dumps(run['params'], default=str))})\n"
             f"body = {{'dataset_id': {('DATASET_ID' if ds else 'None')}, 'params': PARAMS, 'seed': {run['seed']}, 'mode': 'job', 'use_cache': False}}\n"
             f"job = requests.post(f'{{ENGINE}}/v2/run/{run['capability']}', json=body, headers=HEADERS, timeout=60).json()['job']\n\n"
             "import time\n"
             "while (j := requests.get(f\"{ENGINE}/v2/jobs/{job['id']}\", headers=HEADERS, timeout=30).json())['status'] not in ('done', 'failed', 'cancelled'):\n"
             "    print(f\"{j['progress']:.0%} {j['message']}\", end='\\r'); time.sleep(1)\n"
             "assert j['status'] == 'done', j\n"
             "result = requests.get(f\"{ENGINE}/v2/jobs/{job['id']}/result\", headers=HEADERS, timeout=60).json()"),
        md("## Check\n\nThe headline numbers recorded with the run, compared with the new result."),
        code(f"RECORDED = json.loads({json.dumps(json.dumps(run.get('metrics', {}), default=str))})\n"
             "for k, v in RECORDED.items():\n"
             "    cur = result\n"
             "    for part in k.split('.'):\n"
             "        cur = cur.get(part) if isinstance(cur, dict) else None\n"
             "    same = cur == v or (isinstance(v, float) and isinstance(cur, float) and abs(cur - v) <= 1e-9 * max(1, abs(v)))\n"
             "    print(('✓' if same else '✗'), k, v, cur)"),
        md(meth["markdown"]),
    ]
    return {"nbformat": 4, "nbformat_minor": 5, "cells": cells,
            "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
                         "language_info": {"name": "python"}, "askdeepakai": {"runId": run["id"], "manifest": man}}}
