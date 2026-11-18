"""Engine v2: pretrained transformer text models (ONNX Runtime, CPU). These run the real pinned models."""
import random

import numpy as np
import pytest
from conftest import run, upload_rows


def test_embedding_matches_published_similarity():
    # sentence-transformers' documented example for all-MiniLM-L6-v2: cos("A man is eating food.", "A man is eating a piece of bread.") ≈ 0.7553
    from engine import text_models as tm

    v = tm.runtime(tm.MODELS["minilm-en"]).embed(["A man is eating food.", "A man is eating a piece of bread.", "A man is riding a horse."])
    assert v.shape == (3, 384) and np.allclose(np.linalg.norm(v, axis=1), 1, atol=1e-5)
    assert float(v[0] @ v[1]) == pytest.approx(0.7553, abs=0.01)
    assert float(v[0] @ v[2]) < float(v[0] @ v[1])


def test_text_models_listed(client):
    models = {m["key"]: m for m in client.get("/v2/text-models").json()}
    assert set(models) == {"minilm-en", "minilm-multilingual", "roberta-sentiment", "deberta-nli", "bert-ner"}
    assert all(m["installed"] and m["revision"] and m["license"] for m in models.values())
    assert models["roberta-sentiment"]["attribution"]


TICKETS = ["How do I reset my password?", "I can't log in to my account", "The parcel never arrived", "My package is lost in transit",
           "I was charged twice this month", "Why is there an extra fee on my bill?", "How do I reset my password?"]


def test_semantic_search_finds_meaning_not_words(client):
    ds = upload_rows(client, [{"t": t, "id": i} for i, t in enumerate(TICKETS)], "tickets sem")
    r = run(client, "text.semantic_search", ds, column="t", query=["I forgot my login credentials", "where is my delivery"], top=2, show_columns=["id"])
    first, second = r["results"]
    assert {m["row"] for m in first["matches"]} <= {0, 1, 6}
    assert {m["row"] for m in second["matches"]} == {2, 3}
    assert "id" in first["matches"][0]
    texts = [m["text"] for m in first["matches"]]
    assert len(texts) == len(set(texts))  # identical texts are one match…
    pw = next(m for m in first["matches"] if m["text"] == "How do I reset my password?")
    assert pw["count"] == 2  # …with how many rows share it
    d = run(client, "text.semantic_search", ds, column="t", duplicate_threshold=0.95)
    assert d["duplicateGroups"][0]["rows"] == [0, 6]


def test_embed_map_and_save(client):
    ds = upload_rows(client, [{"t": t, "kind": "account" if i in (0, 1, 6) else "other"} for i, t in enumerate(TICKETS)], "tickets embed")
    r = run(client, "text.embed", ds, column="t", color_by="kind", save=True)
    assert r["dimensions"] == 384 and len(r["map"]) == len(TICKETS) and "color" in r["map"][0]
    assert r["dataset"]["rows"] == len(TICKETS) and len(r["dataset"]["columns"]) == 2 + 384


def test_transformer_sentiment(client):
    pos = ["Absolutely love it, works perfectly", "Fantastic service, thank you so much", "Best purchase I've made this year"]
    neg = ["Terrible, it broke after one day", "Worst customer service ever", "Complete waste of money, very disappointed"]
    rows = [{"review": pos[i % 3], "store": "A"} for i in range(9)] + [{"review": neg[i % 3], "store": "B"} for i in range(9)] + \
           [{"review": "The order number is 4471.", "store": "C"}]
    ds = upload_rows(client, rows, "sentiment tr")
    r = run(client, "text.sentiment", ds, column="review", group="store", save=True)
    groups = {g["group"]: g for g in r["byGroup"]}
    assert groups["A"]["positiveShare"] == 1 and groups["B"]["negativeShare"] == 1 and groups["C"]["neutralShare"] == 1
    assert groups["A"]["meanScore"] > 0.8 > -0.8 > groups["B"]["meanScore"]
    assert r["model"]["license"] == "CC-BY-4.0" and r["model"]["attribution"]
    assert "sentiment_positive" in [c["name"] for c in r["dataset"]["columns"]]


def test_zero_shot_labels(client):
    texts = {"shipping": ["The delivery took three weeks", "My parcel was sent to the wrong address", "Courier never showed up"],
             "price": ["Far too expensive for what it is", "Great value for the money", "The subscription costs went up again"],
             "product quality": ["The battery died after two days", "Screen cracked on its own", "Build quality feels cheap and flimsy"]}
    rows = [{"t": t, "truth": k} for k, v in texts.items() for t in v]
    ds = upload_rows(client, rows, "zero shot")
    r = run(client, "text.zero_shot", ds, column="t", labels=list(texts), save=True)
    pred = {s["text"]: s["label"] for s in r["sample"]}
    acc = np.mean([pred[row["t"]] == row["truth"] for row in rows])
    assert acc >= 7 / 9, pred
    m = run(client, "text.zero_shot", ds, column="t", labels=list(texts), multi_label=True)
    assert m["multiLabel"] and set(m["shares"]) == set(texts)


def test_named_entities(client):
    rows = [{"t": "Tim Cook announced the results at Apple headquarters in Cupertino."},
            {"t": "Angela Merkel met officials from Siemens in Berlin."},
            {"t": "Apple and Siemens both opened offices in London."},
            {"t": "nothing to see here"}]
    ds = upload_rows(client, rows, "ner")
    r = run(client, "text.entities", ds, column="t", save=True)
    by = {t["type"]: {x["text"]: x["count"] for x in t["top"]} for t in r["byType"]}
    assert by["PER"].keys() >= {"Tim Cook", "Angela Merkel"}
    assert by["ORG"]["Apple"] == 2 and by["ORG"]["Siemens"] == 2
    assert {"Cupertino", "Berlin", "London"} <= set(by["LOC"])
    assert r["rowsWithEntities"] == 3
    first = r["sample"][0]["entities"][0]
    assert rows[0]["t"][first["start"]:first["end"]] == first["text"]


THEMES = {
    "shipping": ["My order never arrived", "The courier left the box at the wrong house", "Delivery was two weeks late", "Tracking hasn't updated since Monday",
                 "The parcel came damaged in transit", "Shipping to my country takes forever", "The driver didn't even ring the bell",
                 "My package is stuck at the depot", "They sent it to my old address", "Express delivery took longer than standard",
                 "Still waiting for the shipment to leave the warehouse", "The delivery slot was missed twice"],
    "battery": ["The battery drains in a few hours", "It won't hold a charge anymore", "Charging takes all night", "Battery life is terrible after the update",
                "The phone dies by lunchtime", "It gets hot while charging", "Battery percentage jumps around randomly", "Needs to be plugged in constantly",
                "Battery swelled after six months", "Power drops from 40% to zero instantly", "The charger stopped working with it",
                "Standby drains the battery overnight"],
    "billing": ["I was charged twice this month", "My refund still hasn't come through", "There's a fee on my invoice I don't recognise",
                "They billed me after I cancelled", "The price on my statement is higher than advertised", "Payment failed but money left my account",
                "I need a copy of my receipt for tax", "The discount code wasn't applied to my bill", "Why did my subscription cost go up?",
                "I was charged in the wrong currency", "My card was billed for someone else's order", "The VAT on the invoice is wrong"],
}


def test_semantic_topics_recover_themes(client):
    from sklearn.metrics import adjusted_rand_score

    rows = [{"t": t, "truth": k} for k, v in THEMES.items() for t in v] * 3
    ds = upload_rows(client, rows, "topics")
    r = run(client, "text.semantic_topics", ds, column="t", n_topics=3, save=True)
    assert len(r["topics"]) == 3 and r["dataset"]["rows"] == len(rows)
    import pandas as pd

    labelled = pd.DataFrame(client.get(f"/v2/datasets/{r['dataset']['id']}/preview", params={"limit": 1000}).json()["rows"])
    assert adjusted_rand_score(labelled["truth"], labelled["topic"]) > 0.8
    found = run(client, "text.semantic_topics", ds, column="t", min_topic_size=20)
    assert 2 <= len(found["topics"]) <= 5 and found["outlierShare"] < 0.4


def test_automl_with_text_embeddings_and_serving(client):
    rnd = random.Random(1)
    a = ["the screen is cracked", "display shattered after a drop", "touchscreen stopped responding", "there are dead pixels on the panel"]
    b = ["refund still hasn't come through", "I was charged the wrong amount", "please cancel my subscription payment", "my invoice is incorrect"]
    rows = [{"msg": rnd.choice(a), "team": "hardware"} for _ in range(60)] + [{"msg": rnd.choice(b), "team": "billing"} for _ in range(60)]
    ds = upload_rows(client, rows, "routing")
    r = run(client, "ml.automl", ds, target="team", models=["linear"], text_encoder="minilm-en", text_columns=["msg"], time_budget_s=20, max_trials_per_model=2,
            cv_folds=3, ensemble=False, name="ticket-router")
    assert "msg" in r["features"]["text"] and r["test"]["accuracy"] >= 0.95
    pred = client.post("/v2/models/ticket-router/predict", json={"rows": [{"msg": "the glass on my monitor broke"}, {"msg": "you billed me twice"}], "log": False}).json()
    assert [p["prediction"] for p in pred["predictions"]] == ["hardware", "billing"]


def test_missing_model_offline_is_a_clear_error(monkeypatch, tmp_path):
    from engine import text_models as tm
    from engine.core import EngineError

    monkeypatch.setenv("ENGINE_MODEL_DIR", str(tmp_path))
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    with pytest.raises(EngineError) as err:
        tm.download(tm.MODELS["bert-ner"])
    assert err.value.status == 503 and err.value.code == "model_unavailable"
