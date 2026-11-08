# Hazel - AWS Deployment Guide

Hazel runs on AWS Lambda as a container image behind an API Gateway HTTP API.
The [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter)
passes API Gateway requests to Hazel's ordinary Node.js HTTP server.

Deploys go through [scripts/deploy.sh](./scripts/deploy.sh). It builds the
image, pushes it to ECR, deploys [template.yaml](./template.yaml) with
CloudFormation, checks the endpoint and rolls back if the check fails. Run it
from the [Deploy workflow](#deploying-from-github-actions) or from your machine.

## Prerequisites for local deploys

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

## Deploying from GitHub Actions

The [Deploy workflow](./.github/workflows/deploy.yml) runs `scripts/deploy.sh`
on a GitHub runner, so it needs no local Docker or MFA session. Run it from
**Actions → Deploy → Run workflow**, or:

```bash
gh workflow run deploy.yml -R Curvo-AI/hazel --ref master -f stack=hazel-update-server-test
```

- `stack` is `hazel-update-server-test` (the default) or `hazel-update-server`.
  Production runs in the `production` environment and wait for a reviewer to
  approve them.
- `dry-run` shows the changeset and deletes it without deploying. It still
  pushes the image to ECR.
- The run deploys the commit it was started on and keeps the stack's current
  parameters. To change a parameter, deploy from your machine.

The workflow assumes an IAM role through GitHub OIDC; there are no stored AWS
keys. [github-deploy-role.yaml](./github-deploy-role.yaml) defines one role per
stack, each trusting only its own GitHub environment and limited to that
stack's resources and the `hazel-update-server` ECR repository. The test role
cannot change the production stack.

### One-off setup

1. Create both roles (needs an MFA session):

   ```bash
   AWS_PROFILE=curvo-ai-mfa aws cloudformation deploy --region eu-west-2 --template-file github-deploy-role.yaml --capabilities CAPABILITY_NAMED_IAM --stack-name hazel-github-deploy-test --parameter-overrides HazelStackName=hazel-update-server-test
   AWS_PROFILE=curvo-ai-mfa aws cloudformation deploy --region eu-west-2 --template-file github-deploy-role.yaml --capabilities CAPABILITY_NAMED_IAM --stack-name hazel-github-deploy-production --parameter-overrides HazelStackName=hazel-update-server
   ```

2. In the repository's **Settings → Environments**, create `test` and
   `production`. Give `production` required reviewers and limit its deployment
   branches to `master`.
3. In each environment, set the variable `AWS_DEPLOY_ROLE_ARN` to the
   `RoleArn` output of the matching stack
   (`arn:aws:iam::<account>:role/github-actions-hazel-deploy-test` or
   `…-production`).

The test role may create and replace HTTP APIs other than production's,
because a recreated test stack gets a new API. The production role is pinned
to production's API ID in the template; if the production stack is ever
recreated, update that ID and redeploy its role stack.

## Deploying from your machine

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
   for confirmation. `--yes` deploys without asking and `--dry-run` deletes the
   changeset instead; the workflow uses these.
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

### The production URL is locked

Every installed Companion has the production `execute-api` URL built in, and
the URL is made from the API's ID. If CloudFormation ever replaced or deleted
the API, those installs would never find another update. So production has:

- **Termination protection**, so the stack can't be deleted.
- **The stack policy in [stack-policy.json](./stack-policy.json)**, which denies
  replacing or deleting `ServerlessHttpApi` and its `$default` stage. A template
  that would replace them fails to execute. One that removes or renames them
  fails while the changeset is created, with `Unknown logical id` in the error.

Ordinary deploys, parameter changes and rollbacks are unaffected. To apply the
same lock to a new stack:

```bash
aws cloudformation set-stack-policy --stack-name hazel-update-server --stack-policy-body file://stack-policy.json
aws cloudformation update-termination-protection --stack-name hazel-update-server --enable-termination-protection
```

### Custom domain

A stack can serve an extra hostname, such as `updates.curvo.ai`, in front of
the same API:

```bash
AWS_PROFILE=curvo-ai-mfa npm run aws:deploy -- hazel-update-server CustomDomainName=updates.curvo.ai HostedZoneId=Z01447682NMUY8FGBAAHE
```

This creates a DNS-validated ACM certificate that renews itself, an API
Gateway custom domain and a Route 53 alias record. The smoke check then
requires a `200` from both URLs.

The domain is an addition, never a replacement:

- **Keep the execute-api URL working.** Installed Companions have it built in,
  and the lock above protects it. Don't disable the execute-api endpoint.
- **Clients must fall back.** A Companion that uses the domain needs the
  execute-api URL as a runtime fallback, so a DNS or certificate problem
  can't strand it. Don't point `CURVO_UPDATE_SERVER_URL` at the domain until
  Companion has that fallback.
- **Links stay on the URL that was asked.** Hazel builds download and
  RELEASES links from the request's host, so a client that falls back stays
  on execute-api.

Don't look the hostname up before the first deploy creates it. Resolvers can
cache the "doesn't exist" answer and the smoke check would fail.

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

A test stack with the lock applied needs it lifted first:

```bash
aws cloudformation update-termination-protection --stack-name hazel-update-server-test --no-enable-termination-protection --region eu-west-2
aws cloudformation delete-stack --stack-name hazel-update-server-test --region eu-west-2
```

Never lift it on `hazel-update-server`.

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
