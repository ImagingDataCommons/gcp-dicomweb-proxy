#!/usr/bin/env bash
# Deploy one read-only DICOMweb proxy, as a Cloud Run function, for one DICOM store.
#
#   ./deploy.sh <project> <function-name> <store> [<region>]
#
#   project        Google Cloud project the function is deployed in
#   function-name  becomes the URL: https://<region>-<project>.cloudfunctions.net/<function-name>
#   store          projects/P/locations/L/datasets/D/dicomStores/S, or its DICOMweb URL;
#                  it may be in another project
#   region         defaults to the store's location (us-central1 for a multi-region store);
#                  to take over the URL of an existing function, give that function's region
#
# The function runs as its own service account, which can only read this one store
# (roles/healthcare.dicomViewer on the store). Re-running the script redeploys in place.
set -euo pipefail

if [[ $# -lt 3 || $# -gt 4 ]]; then
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
PROJECT=$1
NAME=$2
STORE_ARG=$3

STORE=${STORE_ARG#https://healthcare.googleapis.com/v1/}
STORE=${STORE%/}
STORE=${STORE%/dicomWeb}
if [[ ! $STORE =~ ^projects/([^/]+)/locations/([^/]+)/datasets/([^/]+)/dicomStores/([^/]+)$ ]]; then
  echo "Not a DICOM store: $STORE_ARG" >&2
  exit 2
fi
STORE_PROJECT=${BASH_REMATCH[1]}
STORE_LOCATION=${BASH_REMATCH[2]}
STORE_DATASET=${BASH_REMATCH[3]}
STORE_ID=${BASH_REMATCH[4]}

if [[ $# -eq 4 ]]; then
  REGION=$4
elif [[ $STORE_LOCATION == *-* ]]; then
  REGION=$STORE_LOCATION
else
  REGION=us-central1
fi

# Service account id: 6-30 chars of [a-z0-9-], starting with a letter.
SA_ID=$(echo "dwp-$NAME" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')
if [[ ${#SA_ID} -gt 30 ]]; then
  SA_ID="${SA_ID:0:25}-$(echo -n "$NAME" | shasum | cut -c1-4)"
fi
SA_ID=${SA_ID%-}
SA="$SA_ID@$PROJECT.iam.gserviceaccount.com"

echo "Function:        $NAME ($PROJECT, $REGION)"
echo "Store:           $STORE"
echo "Service account: $SA"
echo

if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_ID" --project "$PROJECT" \
    --display-name "DICOMweb proxy $NAME (read-only)" \
    --description "Reads $STORE for the public proxy $NAME"
fi

# A service account just created can take a minute to be visible to the store's
# IAM ("Service account ... does not exist"), so the grant is retried.
for attempt in 1 2 3 4 5 6; do
  if gcloud healthcare dicom-stores add-iam-policy-binding "$STORE_ID" \
      --project "$STORE_PROJECT" --location "$STORE_LOCATION" --dataset "$STORE_DATASET" \
      --member "serviceAccount:$SA" --role roles/healthcare.dicomViewer --condition None \
      --format none; then
    break
  fi
  if [[ $attempt -eq 6 ]]; then
    echo "Could not grant $SA read access to the store; nothing was deployed." >&2
    exit 1
  fi
  echo "Retrying the grant in 20 s ..." >&2
  sleep 20
done

cd "$(dirname "$0")"
# --quiet answers "allow unauthenticated?" with no; public access is granted below,
# as its own step, because it needs a permission that deploying does not.
gcloud functions deploy "$NAME" --quiet \
  --gen2 --project "$PROJECT" --region "$REGION" \
  --runtime nodejs24 --source . --entry-point dicomwebProxy --trigger-http \
  --service-account "$SA" \
  --set-env-vars "DICOMWEB_URL=$STORE" \
  --memory 512Mi --cpu 1 --concurrency 80 --max-instances 10 --timeout 300s

URL="https://$REGION-$PROJECT.cloudfunctions.net/$NAME"
PUBLIC_CMD="gcloud functions add-invoker-policy-binding $NAME --region=$REGION --project=$PROJECT --member=allUsers"
echo
if $PUBLIC_CMD --format none 2>/dev/null; then
  echo "Public: $URL"
else
  echo "Deployed, but NOT public: making it public needs run.services.setIamPolicy"
  echo "(Owner or Cloud Run Admin on $PROJECT). With such an account, run:"
  echo "  $PUBLIC_CMD"
  echo "Until then, test with ID_TOKEN=\$(gcloud auth print-identity-token)."
fi
echo
echo "Test (new IAM grants can take a minute to apply):"
echo "  ACCESS_TOKEN=\$(gcloud auth print-access-token) node smoke-test.js $URL $STORE"
