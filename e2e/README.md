# End-to-end tests

Black-box tests of the real Docker image. Hazel's code runs unmodified;
GitHub and SSM are replaced by [mock.js](mock.js), which Hazel reaches through
`--add-host` DNS overrides and a throwaway CA trusted via `NODE_EXTRA_CA_CERTS`.

Needs Docker, Node 24 and OpenSSL.

```sh
npm run e2e                           # scenario suite and Lambda path
BASELINE=v5.1.1 npm run e2e           # compare against another ref
TOKEN=$(gh auth token) npm run e2e:parity
```

## What each part covers

- **[scenarios.js](scenarios.js)** runs each scenario in fresh containers of
  the current image and a baseline image (`origin/master` by default). Checks
  are asserted on the current image; the baseline result is printed alongside
  so behaviour changes are visible. Scenarios cover every route, private
  downloads, stream routing, pagination, concurrent cold requests, GitHub
  503, 403 and hangs with an empty and a stale cache, and SSM configuration.
- **[lambda.js](lambda.js)** runs the image through the Lambda Runtime
  Interface Emulator, so requests go API Gateway v2 event, Lambda Web Adapter,
  then Hazel, as on AWS. It includes a cold start during a GitHub outage,
  which only works because the adapter's readiness check uses TCP.
- **[parity.js](parity.js)** runs the current image against the real
  curvo-companion releases and compares 53 read-only requests with the live
  production endpoint. Run it before deploying; any difference fails.

Results are written to `results.json` and `parity.json` here, and are ignored
by git along with the generated certificates.
