# gcp-dicomweb-proxy

A read-only, unauthenticated DICOMweb proxy for one Google Cloud Healthcare API DICOM store,
deployed as a Cloud Run function. It lets anyone, a web viewer for instance, read a store
without signing in to Google.

One copy of the code serves any store. Each deployment names its store in the `DICOMWEB_URL`
environment variable, so nothing in the code is edited to deploy a new proxy.

## What it does

- Forwards `GET` and `HEAD` requests under the store's `dicomWeb` root, with an access token
  for the function's service account. Responses are streamed back unchanged.
- Answers CORS preflight (`OPTIONS`) itself and allows any origin.
- Refuses every other method with 405, so no STOW and no DELETE. Refuses with 400 any path
  that would leave the store: dot segments, or encoded `/` or `\`.
- Runs as its own service account, which holds `roles/healthcare.dicomViewer` on that one
  store and nothing else. Even a bug in the code could not write to the store, or read another.
- Sends any response over 32 MiB chunked. Cloud Run refuses non-streamed responses above
  that size, and a transcoded SEG can exceed it.

Version 1 of this repository, a 1st-gen Cloud Function, forwarded every method. It ran as the
App Engine default service account, which has Editor on its project, so anyone with the URL
could write to or delete from the store behind it.

## Deploy

```bash
./deploy.sh <project> <function-name> <store> [<region>]
```

For example:

```bash
./deploy.sh my-project my_store_proxy \
  projects/my-project/locations/us-central1/datasets/my-dataset/dicomStores/my-store
```

The script:

1. creates the service account `dwp-<function-name>`;
2. grants it `roles/healthcare.dicomViewer` on the store;
3. deploys the function with Node.js 24, with at most 10 instances;
4. makes it public.

The proxy's URL is `https://<region>-<project>.cloudfunctions.net/<function-name>`, and the
store's DICOMweb root maps to it: `<URL>/studies`, `<URL>/studies/<uid>/series`, and so on.
The region defaults to the store's location. Re-running the script redeploys in place.

You need permission to create service accounts and deploy functions in `<project>` (Editor
is enough), and to set IAM policy on the store, which may be in another project.

The last step also needs `run.services.setIamPolicy`, which Editor does not include (Owner and
Cloud Run Admin do). Without it the script still deploys, but the proxy stays private, and the
script prints the one command to run with an account that has the permission.

## List deployed proxies

Each proxy carries its store in `DICOMWEB_URL`, so the project itself is the list:

```bash
gcloud functions list --project <project> --filter="buildConfig.entryPoint=dicomwebProxy" \
  --format="table(name.basename(),url,serviceConfig.environmentVariables.DICOMWEB_URL)"
```

## Test

```bash
npm install && npm test        # unit tests: store URL parsing, path checks
ACCESS_TOKEN=$(gcloud auth print-access-token) \
  node smoke-test.js <proxy URL> <store>
```

The smoke test walks from `/studies` to one instance and retrieves it. It checks CORS, and
checks that writes and paths outside the store are refused. With `ACCESS_TOKEN` set, it also
checks that the metadata and the Part-10 file are byte-identical to what the store itself
returns. The write checks use a made-up UID and an empty body, so they are harmless even
against a proxy that forwards writes. The test reads at most 64 MiB of each response. To test a
proxy that is not public yet, set `ID_TOKEN=$(gcloud auth print-identity-token)`.

To run the proxy locally against a store:

```bash
GOOGLE_APPLICATION_CREDENTIALS=<credentials.json> DICOMWEB_URL=<store> npm start   # port 8080
```

## Replacing a 1st-gen function and keeping its URL

A function's URL depends only on region, project and name. First delete the 1st-gen function:

```bash
gcloud functions delete <name> --region us-central1 --project <project>
```

Then deploy this code under the same name and region, with `./deploy.sh`. The URL is down
between the two steps, a few minutes.

## Limits of the Healthcare API, not of the proxy

- **Frames of deflated instances.** The store does not serve frames (`/frames/<n>`) or
  `bulkdata` of instances stored as Deflated Explicit VR Little Endian (`1.2.840.10008.1.2.1.99`).
  Retrieve the whole instance instead: `Accept: application/dicom; transfer-syntax=*` returns
  the file as stored.
- **Bulk data links.** `BulkDataURI`s in metadata point at `healthcare.googleapis.com`, which
  needs sign-in. A client that follows them will not get through the proxy.

## Public means public

Anyone with the URL can read the whole store, and the store's project pays for the egress.
`--max-instances 10` caps concurrency, not volume, so consider a budget alert on the project.
