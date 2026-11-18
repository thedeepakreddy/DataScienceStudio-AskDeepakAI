#!/usr/bin/env bash
# Deploys the AskDeepakAI engine to Google Cloud Run and points the Render studio at it.
#
# Run it in Google Cloud Shell (already logged in to gcloud):
#   git clone https://github.com/thedeepakreddy/DataScienceStudio-AskDeepakAI.git
#   cd DataScienceStudio-AskDeepakAI && bash scripts/deploy_engine_cloudrun.sh
#
# It is safe to run again: every step reuses what already exists. Secrets never
# appear on screen: the engine token is generated into Secret Manager, and the
# Render API key is read with a hidden prompt and only sent to api.render.com.
set -euo pipefail

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-askdeepakai-engine}"
say() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f mlops_service/Dockerfile ] || die "Run this from the repository root."

# ---------------------------------------------------------------- project
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  echo "Your projects:"; gcloud projects list --format="value(projectId)" | sed 's/^/  /'
  read -rp "Project ID to deploy into: " PROJECT_ID
fi
gcloud config set project "$PROJECT_ID" >/dev/null
BILLING=$(gcloud billing projects describe "$PROJECT_ID" --format="value(billingAccountName)" 2>/dev/null || true)
if [ -z "$BILLING" ]; then
  echo "Couldn't confirm billing on $PROJECT_ID. Cloud Run needs a linked billing account even for the free tier"
  echo "(Console → Billing). If the deploy fails with a billing error, link one and rerun."
fi
say "Project $PROJECT_ID, region $REGION"

say "Enabling the APIs (first time takes a minute)"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com storage.googleapis.com \
  secretmanager.googleapis.com iam.googleapis.com billingbudgets.googleapis.com --quiet

# ---------------------------------------------------------------- budget alert
if [ -n "$BILLING" ] && ! gcloud billing budgets list --billing-account="${BILLING#billingAccounts/}" --format="value(displayName)" 2>/dev/null | grep -qx "askdeepakai-engine"; then
  say "Creating a \$5 budget alert (emails at 50%, 90%, 100%)"
  gcloud billing budgets create --billing-account="${BILLING#billingAccounts/}" --display-name="askdeepakai-engine" \
    --budget-amount=5USD --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
    --filter-projects="projects/$PROJECT_ID" >/dev/null || echo "  (Couldn't create the budget; add one in Console → Billing → Budgets & alerts.)"
fi

# ---------------------------------------------------------------- storage
BUCKET="gs://${PROJECT_ID}-engine"
if ! gcloud storage buckets describe "$BUCKET" >/dev/null 2>&1; then
  say "Creating the storage bucket $BUCKET"
  gcloud storage buckets create "$BUCKET" --location="$REGION" --uniform-bucket-level-access
fi
cat > /tmp/engine-lifecycle.json <<'EOF'
{"rule": [{"action": {"type": "Delete"}, "condition": {"age": 30, "matchesPrefix": ["engine/cache/", "engine/predlog/", "engine/uploads/"]}}]}
EOF
gcloud storage buckets update "$BUCKET" --lifecycle-file=/tmp/engine-lifecycle.json >/dev/null

# ---------------------------------------------------------------- service account
SA="askdeepakai-engine@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  say "Creating the engine's service account"
  gcloud iam service-accounts create askdeepakai-engine --display-name="AskDeepakAI engine"
  sleep 10  # IAM is eventually consistent
fi
gcloud storage buckets add-iam-policy-binding "$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$SA" --member="serviceAccount:$SA" --role=roles/iam.serviceAccountTokenCreator >/dev/null

# ---------------------------------------------------------------- token
if ! gcloud secrets describe engine-token >/dev/null 2>&1; then
  say "Generating the engine token in Secret Manager"
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets create engine-token --data-file=- --replication-policy=automatic >/dev/null
fi
gcloud secrets add-iam-policy-binding engine-token --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null

# ---------------------------------------------------------------- deploy
say "Building and deploying the engine (Cloud Build; about 10–15 minutes the first time)"
gcloud config set builds/timeout 3600 >/dev/null
gcloud run deploy "$SERVICE" --source mlops_service --region "$REGION" --service-account "$SA" \
  --cpu 2 --memory 4Gi --min-instances 0 --max-instances 2 --concurrency 8 --timeout 3600 \
  --allow-unauthenticated --quiet \
  --set-env-vars "ENGINE_STORAGE=${BUCKET}/engine,ENGINE_LOG_FORMAT=json,ENGINE_SCHEDULER=0" \
  --set-secrets "ENGINE_TOKEN=engine-token:latest"
URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
TOKEN=$(gcloud secrets versions access latest --secret=engine-token)

say "Checking the engine at $URL"
curl -fsS "$URL/health" && echo
curl -fsS -H "X-Engine-Token: $TOKEN" "$URL/v2/info" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  engine',d['engineVersion'],'·',d['capabilities'],'capabilities · storage',d['storage'])"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/v2/info")
[ "$code" = "401" ] && echo "  without the token: 401 (protected) ✓" || die "The engine answered $code without a token; it should refuse."

# ---------------------------------------------------------------- Render
say "Connecting the Render studio"
echo "Create a Render API key at https://dashboard.render.com/u/settings#api-keys (it isn't shown or stored here)."
read -rsp "Render API key: " RENDER_KEY; echo
export RENDER_KEY
SERVICES=$(curl -fsS -H "Authorization: Bearer $RENDER_KEY" "https://api.render.com/v1/services?limit=50") || die "Render rejected the API key."
python3 - "$SERVICES" <<'EOF' > /tmp/render-services.txt
import json, sys
for i, s in enumerate(x["service"] for x in json.loads(sys.argv[1])):
    print(i + 1, s["id"], s["name"], (s.get("serviceDetails") or {}).get("url", ""), sep="\t")
EOF
cat /tmp/render-services.txt | awk -F'\t' '{printf "  %s) %s  %s\n", $1, $3, $4}'
read -rp "Which one is the studio (the web app, not the old ML service)? Number: " PICK
RENDER_ID=$(awk -F'\t' -v n="$PICK" '$1==n {print $2}' /tmp/render-services.txt)
STUDIO=$(awk -F'\t' -v n="$PICK" '$1==n {print $4}' /tmp/render-services.txt)
[ -n "$RENDER_ID" ] || die "No service number $PICK."
for kv in "ML_SERVICE_URL=$URL" "ENGINE_TOKEN=$TOKEN"; do
  key=${kv%%=*}; value=${kv#*=}
  python3 -c 'import json,sys;print(json.dumps({"value":sys.argv[1]}))' "$value" | \
    curl -fsS -o /dev/null -X PUT -H "Authorization: Bearer $RENDER_KEY" -H "Content-Type: application/json" \
      --data @- "https://api.render.com/v1/services/$RENDER_ID/env-vars/$key" || die "Couldn't set $key on Render."
  echo "  set $key"
done
curl -fsS -o /dev/null -X POST -H "Authorization: Bearer $RENDER_KEY" -H "Content-Type: application/json" -d '{}' \
  "https://api.render.com/v1/services/$RENDER_ID/deploys" && echo "  redeploy started"
unset RENDER_KEY TOKEN

if [ -n "$STUDIO" ]; then
  cat > /tmp/engine-cors.json <<EOF
[{"origin": ["$STUDIO"], "method": ["PUT"], "responseHeader": ["Content-Type"], "maxAgeSeconds": 3600}]
EOF
  gcloud storage buckets update "$BUCKET" --cors-file=/tmp/engine-cors.json >/dev/null && echo "  bucket accepts direct uploads from $STUDIO"
fi

say "Done"
echo "  Engine:  $URL"
echo "  Studio:  ${STUDIO:-(see Render)}  — redeploying now, live in a few minutes"
echo "  Check:   ${STUDIO:-<studio>}/api/engine/info"
