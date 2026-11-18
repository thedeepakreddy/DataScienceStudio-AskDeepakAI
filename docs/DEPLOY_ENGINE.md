# Deploying the engine to Google Cloud Run

The studio stays on Render; the Python engine (`mlops_service/`) runs on
Google Cloud Run. The studio's server calls the engine with a shared secret,
and browsers never talk to the engine directly.

```
browser ──▶ studio (Render, server.ts) ──HTTPS + X-Engine-Token──▶ engine (Cloud Run)
                                                                      │
                                                    Cloud Storage bucket (datasets, models,
                                                    results, runs, monitoring, audit log)
```

## What it costs

For a handful of users this fits in Google's free allowances. Check the
current numbers on the [Cloud Run pricing page](https://cloud.google.com/run/pricing),
because they change. When this guide was written (November 2026):

| Service | Free each month | Notes |
|---|---|---|
| Cloud Run, request-based billing | 180,000 vCPU-seconds, 360,000 GiB-seconds, 2 million requests | With 2 vCPU / 4 GiB that is about 25 hours of busy time a month. Idle time is free. |
| Cloud Run, instance-based billing | 240,000 vCPU-seconds, 450,000 GiB-seconds | You pay for the instance's whole life, including idle time before it scales down. |
| Cloud Storage | 5 GB-months of Standard storage in us-central1, us-east1 or us-west1 | Datasets are kept as compressed Parquet: a 265 MB CSV of 5 million rows stored as 26 MB. |
| Cloud Scheduler | 3 jobs per billing account | One job is enough (the schedule tick). |
| Artifact Registry | 0.5 GB of storage | The engine image (about 3.3 GB with the text models) is larger than this, so expect a few cents a month. Delete old images. |

Billing must be enabled even to use the free tier. **Set a budget alert first**
(step 1).

## Two Cloud Run limits the engine is built around

1. **Request bodies are capped at 32 MiB (HTTP/1).** Smaller files upload
   through the studio as usual (`/v2/datasets/upload`). For larger files the
   studio asks for a signed URL (`POST /v2/datasets/upload-url`), the browser
   uploads straight to the bucket, and the studio then imports the file with
   `connect.gcs` and the returned `gcsUri`. Responses are capped at 32 MiB too,
   so large results are saved as datasets, not returned inline.
2. **CPU is throttled outside requests** under request-based billing. A
   background job on an instance with no request in flight barely moves. Use one
   of these two approaches:
   - **Recommended (stays in the free tier):** run heavy analyses with
     `"mode": "sync"`. The studio server keeps that one request open, up to the
     service timeout, while the browser polls the studio (the `X-Async-Job`
     mechanism already in `server.ts`). Schedules use `POST /v2/schedules/tick?wait=true`,
     which also keeps its request open until the runs finish.
   - Or deploy with `--no-cpu-throttling` (instance-based billing). Background
     jobs (`"mode": "job"`) then run at full speed, but idle instance time counts
     against the allowance.

## Quick deploy (one script)

In [Google Cloud Shell](https://shell.cloud.google.com), which is already
logged in to `gcloud`, run:

```bash
git clone https://github.com/thedeepakreddy/DataScienceStudio-AskDeepakAI.git
cd DataScienceStudio-AskDeepakAI && bash scripts/deploy_engine_cloudrun.sh
```

The script does steps 1–5 and 7 below:

- the APIs and a $5 budget alert;
- the bucket;
- the service account;
- the token, generated in Secret Manager;
- the build and deploy;
- checks that the engine answers and refuses requests without the token.

It then asks for a Render API key at a hidden prompt, sets `ML_SERVICE_URL`
and `ENGINE_TOKEN` on the studio service you pick, and redeploys it.

The script is safe to rerun. Secrets are never printed.

## Steps

The commands use the `gcloud` CLI. Replace `PROJECT_ID`, and keep `us-central1`
(one of the free-tier regions).

### 1. Project, APIs and a budget alert

```bash
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  storage.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com
```

In the console, open **Billing → Budgets & alerts** and create a budget of
$5 with alerts at 50%, 90% and 100%.

### 2. A bucket for the engine's storage

```bash
gcloud storage buckets create gs://PROJECT_ID-engine --location=us-central1 --uniform-bucket-level-access
```

Optional: to keep storage small, add a lifecycle rule that deletes old cache
entries and prediction logs. Save this as `lifecycle.json`:

```json
{"rule": [{"action": {"type": "Delete"}, "condition": {"age": 30, "matchesPrefix": ["engine/cache/", "engine/predlog/", "engine/uploads/"]}}]}
```

```bash
gcloud storage buckets update gs://PROJECT_ID-engine --lifecycle-file=lifecycle.json
```

For direct browser uploads, allow the studio's origin to `PUT` to the bucket.
Save this as `cors.json`:

```json
[{"origin": ["https://YOUR-STUDIO.onrender.com"], "method": ["PUT"], "responseHeader": ["Content-Type"], "maxAgeSeconds": 3600}]
```

```bash
gcloud storage buckets update gs://PROJECT_ID-engine --cors-file=cors.json
```

### 3. A service account for the engine

```bash
gcloud iam service-accounts create askdeepakai-engine
SA=askdeepakai-engine@PROJECT_ID.iam.gserviceaccount.com
gcloud storage buckets add-iam-policy-binding gs://PROJECT_ID-engine --member=serviceAccount:$SA --role=roles/storage.objectAdmin
# Signing upload URLs: the account signs as itself.
gcloud iam service-accounts add-iam-policy-binding $SA --member=serviceAccount:$SA --role=roles/iam.serviceAccountTokenCreator
# Only if you use the BigQuery connector:
gcloud projects add-iam-policy-binding PROJECT_ID --member=serviceAccount:$SA --role=roles/bigquery.jobUser
gcloud projects add-iam-policy-binding PROJECT_ID --member=serviceAccount:$SA --role=roles/bigquery.dataViewer
```

### 4. The shared secret

```bash
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create engine-token --data-file=-
gcloud secrets add-iam-policy-binding engine-token --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
gcloud secrets versions access latest --secret=engine-token   # copy it for Render (step 7)
```

### 5. Deploy

From the repository root:

```bash
gcloud run deploy askdeepakai-engine \
  --source mlops_service --region us-central1 \
  --service-account $SA \
  --cpu 2 --memory 4Gi --min-instances 0 --max-instances 2 --concurrency 8 --timeout 3600 \
  --allow-unauthenticated \
  --set-env-vars ENGINE_STORAGE=gs://PROJECT_ID-engine/engine,ENGINE_LOG_FORMAT=json,ENGINE_SCHEDULER=0 \
  --set-secrets ENGINE_TOKEN=engine-token:latest
```

- `--allow-unauthenticated` lets the request reach the container. The engine
  itself then rejects every request without the token, except `/` and `/health`.
- `--max-instances 2` caps the bill. Each instance runs one Uvicorn worker.
- `ENGINE_SCHEDULER=0` turns off the in-process scheduler, which would sleep
  with the instance. Cloud Scheduler drives schedules instead (step 6).
- `ENGINE_LOG_FORMAT=json` gives structured logs in Cloud Logging.
- The image build downloads the pinned text models from Hugging Face (about 530 MB), and the engine then runs with the hub offline (`HF_HUB_OFFLINE=1`).
- Cloud Run's filesystem is held in memory. With `ENGINE_STORAGE=gs://…`, data
  lives in the bucket and only a working cache sits on local disk.

Check it works:

```bash
URL=$(gcloud run services describe askdeepakai-engine --region us-central1 --format='value(status.url)')
curl $URL/health
curl -H "X-Engine-Token: $(gcloud secrets versions access latest --secret=engine-token)" $URL/v2/info
```

### 6. Schedules (optional)

```bash
gcloud scheduler jobs create http engine-tick --location us-central1 --schedule="*/15 * * * *" \
  --uri="$URL/v2/schedules/tick?wait=true" --http-method=POST --attempt-deadline=30m \
  --headers="X-Engine-Token=$(gcloud secrets versions access latest --secret=engine-token)"
```

### 7. Point the studio at it (Render)

In the Render dashboard, under the studio service's **Environment**, set:

| Variable | Value |
|---|---|
| `ML_SERVICE_URL` | the `$URL` from step 5 |
| `ENGINE_TOKEN` | the secret from step 4 |

The studio's existing endpoints keep working. The new engine is reachable
through the studio at `/api/engine/…`, which passes requests through to
`<engine>/v2/…` with the token added.

## Engine settings

| Variable | Default | What it does |
|---|---|---|
| `ENGINE_TOKEN` | unset (open) | Shared secret; every request except `/` and `/health` must send it in `X-Engine-Token`. |
| `ENGINE_STORAGE` | a temp folder | `gs://bucket/prefix` for Cloud Storage, or a local folder. |
| `ENGINE_MAX_UPLOAD_MB` | 2048 | Largest file accepted by `/v2/datasets/upload`. On Cloud Run the 32 MiB cap applies first. |
| `ENGINE_JOB_WORKERS` | 2 | Background jobs run at once per instance. |
| `ENGINE_SCHEDULER` | 1 | In-process schedule checks every 30 s. Set to 0 on Cloud Run. |
| `ENGINE_TICK_WAIT_S` | 840 | How long `tick?wait=true` waits for runs. |
| `ENGINE_LOG_FORMAT` | text | `json` for structured logs. |
| `ENGINE_LOG_LEVEL` | INFO | Log level. |
| `ENGINE_PREDICTION_LOG` | 1 | Keep a capped log of online predictions, for monitoring. |
| `ENGINE_REQUIRE_APPROVAL` | 0 | 1 = promoting a model to production needs an approver. |
| `ENGINE_MODEL_DIR` | `~/.cache/askdeepakai-models` | Where the text models live (`/app/models` in the image). |
| `ENGINE_TEXT_THREADS` | CPU count | Threads for text-model inference. |
| `ENGINE_ALLOW_PRIVATE_NETWORK` | 0 | 1 = connectors may reach private addresses (local development only). |

## Running locally

```bash
cd mlops_service
python3.13 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
ENGINE_SCHEDULER=0 pytest tests -q
uvicorn main:app --port 8000
```

`docker compose up` builds the same image and runs the studio and engine together.

## Updating dependencies

`requirements.in` lists what the code imports; `requirements.txt` is the pinned
lockfile that the image, CI and tests use.

```bash
python3.13 -m venv /tmp/lock && /tmp/lock/bin/pip install -r requirements.in
/tmp/lock/bin/pip freeze > requirements.txt     # then re-add the two header lines
/tmp/lock/bin/pip install -r requirements-dev.txt && /tmp/lock/bin/python -m pytest tests -q
```

Check the freeze for pre-releases (`dev`, `rc`, `a`, `b` in a version) and pin
a stable release in `requirements.in` if any appear. `wrapt` is pinned for
this reason.

## Security notes

- The token is the only gate, so keep it secret and rotate it with a new
  secret version, then redeploy and update Render.
- Models are stored with joblib, which can run code when loaded. The engine
  only loads models it trained itself, and there is no endpoint to upload a
  model file; don't add one.
- Connector passwords are never written to results, manifests or logs.
- The audit log (`GET /v2/audit`) records method, path, status, time and the
  `X-Engine-User` header, never bodies or tokens.
