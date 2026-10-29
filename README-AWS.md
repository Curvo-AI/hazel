# Hazel - AWS Deployment Guide

Hazel runs on AWS Lambda as a container image behind an API Gateway HTTP API.
The [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter)
passes API Gateway requests to Hazel's ordinary Node.js HTTP server.

Deploys go through [scripts/deploy.sh](./scripts/deploy.sh). It builds the
image, pushes it to ECR, deploys [template.yaml](./template.yaml) with
CloudFormation, checks the endpoint and rolls back if the check fails.

## Prerequisites

1. **AWS CLI** with credentials for the target account
2. **Docker** with `buildx` (Docker Desktop includes it)
3. **An MFA session.** In the Curvo account, CloudFormation deploys fail with
   `S3 error: Access Denied` without one. Refresh the `curvo-ai-mfa` profile
   with `aws sts get-session-token` and deploy with `AWS_PROFILE=curvo-ai-mfa`.

## Configuration

Hazel reads `ACCOUNT`, `REPOSITORY` and `TOKEN` from SSM Parameter Store when it
starts. Create them before the first deploy; see [SSM-SETUP.md](./SSM-SETUP.md).

Stack parameters, all optional:

- `SSMParameterPrefix`: where the SSM parameters live (default `/sst/hazel/production/secrets`)
- `Pre`: set to `1` to serve only pre-releases
- `Interval`: cache refresh interval in minutes (default `15`)

## Deploying

Commit your changes, then:

```bash
AWS_PROFILE=curvo-ai-mfa npm run aws:deploy
```

The script:

1. Refuses to run with uncommitted changes, because the image is tagged with
   the commit.
2. Builds the image for `linux/amd64` and pushes it to the `hazel-update-server`
   ECR repository with Docker v2 media types and no attestations, tagged with
   the commit. It deploys the image's digest, so a rebuild of the same commit
   still replaces what Lambda runs.
3. Creates a CloudFormation changeset, shows it with the current image, and asks
   for confirmation.
4. Deploys and waits for the stack to finish.
5. Requests the endpoint and requires a `200`, which proves the new image
   loaded release data from GitHub. Otherwise it redeploys the exact image that
   was running before and exits non-zero. During a GitHub outage this means
   the deploy rolls back; retry once GitHub is back.

To deploy another stack, such as a temporary test stack, or to change a
parameter, pass them after `--`:

```bash
AWS_PROFILE=curvo-ai-mfa npm run aws:deploy -- hazel-update-server-test
AWS_PROFILE=curvo-ai-mfa npm run aws:deploy -- hazel-update-server Interval=30
```

Parameters you don't pass keep their current values. Set `AWS_REGION` to deploy
outside `eu-west-2`.

### Before deploying production

Deploy the change to a test stack and compare it with production:

```bash
AWS_PROFILE=curvo-ai-mfa npm run aws:deploy -- hazel-update-server-test
CANDIDATE=https://<test-api-id>.execute-api.eu-west-2.amazonaws.com node e2e/parity.js
```

Delete the test stack afterwards (see Cleanup).

### Why not `sam build && sam deploy`

With Docker Desktop's containerd image store, the image SAM pushed had a mixed
OCI manifest that Lambda could not start. Every request failed with
`Runtime.InvalidEntrypoint` (`ProcessSpawnFailed`), even for unchanged code.
The script pins the format Lambda is known to run.

## Testing

```bash
npm test          # lint and unit tests
npm run e2e       # Docker image end to end, including the Lambda path
```

See [e2e/README.md](./e2e/README.md). To run the server directly:

```bash
USE_LOCAL_ENV=true ACCOUNT=your-account REPOSITORY=your-repo npm run dev:local
```

## Logs

```bash
npm run aws:logs
```

This uses the SAM CLI (`brew install aws-sam-cli`). Without it, open the
`/aws/lambda/hazel-update-server-HazelFunction-…` log group in CloudWatch.

## Updating SSM Parameters

SSM changes need no deploy:

```bash
aws ssm put-parameter \
  --name "/sst/hazel/production/secrets/TOKEN" \
  --value "new-token-value" \
  --type "SecureString" \
  --overwrite
```

Running Lambda containers keep the old value until they are replaced. A deploy
replaces them straight away.

## Using in Your Electron App

```js
const { app, autoUpdater } = require('electron')

const server = 'https://xxxxxxxxxx.execute-api.eu-west-2.amazonaws.com'
const url = `${server}/update/${process.platform}/${app.getVersion()}`

autoUpdater.setFeedURL({ url })
```

## Cost Estimation

AWS Lambda pricing (as of 2024):
- **Free tier**: 1M requests/month + 400,000 GB-seconds compute time
- **After free tier**: $0.20 per 1M requests + $0.0000166667 per GB-second

API Gateway HTTP API pricing: $1.00 per million requests, with no free tier.

For about 300,000 update checks a month, expect about $0.30, mostly API Gateway.

## Cleanup

```bash
aws cloudformation delete-stack --stack-name hazel-update-server-test --region eu-west-2
```

Images stay in the `hazel-update-server` ECR repository, which production also
uses. Delete a test stack's images only if no stack still runs them.

## Troubleshooting

### Every request returns 500 with `Runtime.InvalidEntrypoint`

The image was pushed in a format Lambda can't start. Deploy with
`scripts/deploy.sh`, not `sam deploy`. The script rolls back automatically when
this happens.

### `S3 error: Access Denied` while creating the changeset

The deploy ran without an MFA session. Refresh `curvo-ai-mfa` and retry.

### "Error loading SSM parameters" or "Missing configuration properties"

1. Check the parameters exist in the stack's region:
   ```bash
   aws ssm get-parameters-by-path --path "/sst/hazel/production/secrets" --region eu-west-2
   ```
2. Create any that are missing (see [SSM-SETUP.md](./SSM-SETUP.md)).
3. Check `SSMParameterPrefix` on the stack matches where the parameters live.

### Cache not refreshing

Releases are reloaded every `Interval` minutes. If GitHub fails, Hazel keeps
serving the cached release and tries again after the next interval.

### Private repository not working

1. The `TOKEN` SSM parameter holds a valid GitHub token with `repo` scope.
2. It is a `SecureString`.

## Architecture

```
┌─────────────┐      ┌──────────────┐      ┌─────────────────┐
│   Client    │─────▶│ API Gateway  │─────▶│ Lambda Function │
│ (Electron)  │      │  (HTTP API)  │      │  (Container)    │
└─────────────┘      └──────────────┘      └─────────────────┘
                                                     │
                                                     ▼
                                            ┌─────────────────┐
                                            │  GitHub API     │
                                            │  (Release Data) │
                                            └─────────────────┘
```
