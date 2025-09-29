# Hazel - AWS Deployment Guide

This guide explains how to deploy Hazel to AWS using AWS SAM (Serverless Application Model) with Lambda Web Adapter.

## Prerequisites

1. **AWS CLI**: Install and configure AWS CLI with your credentials
   ```bash
   aws configure
   ```

2. **AWS SAM CLI**: Install the AWS SAM CLI
   ```bash
   # macOS
   brew install aws-sam-cli
   
   # Or download from: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
   ```

3. **Docker**: Required for building the Lambda container image
   ```bash
   # macOS
   brew install --cask docker
   ```

## Configuration

Hazel loads configuration from AWS Systems Manager (SSM) Parameter Store for secure secret management.

### Required SSM Parameters

Create these parameters in AWS SSM Parameter Store:

- `/sst/hazel/production/secrets/ACCOUNT` - Your GitHub username or organization name
- `/sst/hazel/production/secrets/REPOSITORY` - Your GitHub repository name (e.g., "electron-app")
- `/sst/hazel/production/secrets/TOKEN` - (Optional) GitHub personal access token for private repositories

**See [SSM-SETUP.md](./SSM-SETUP.md) for detailed setup instructions.**

### Optional Environment Variables

- `PRE`: Set to `1` to serve only pre-releases
- `INTERVAL`: Cache refresh interval in minutes (default: 15)
- `SSMParameterPrefix`: Custom SSM parameter prefix (default: `/sst/hazel/production/secrets`)

### Setup Steps

1. **Create SSM Parameters** (before deployment):
   
   ```bash
   # Create required SSM parameters
   aws ssm put-parameter \
     --name "/sst/hazel/production/secrets/ACCOUNT" \
     --value "your-github-account" \
     --type "String"
   
   aws ssm put-parameter \
     --name "/sst/hazel/production/secrets/REPOSITORY" \
     --value "your-repo-name" \
     --type "String"
   
   # Optional: for private repos
   aws ssm put-parameter \
     --name "/sst/hazel/production/secrets/TOKEN" \
     --value "ghp_xxxxxxxxxxxx" \
     --type "SecureString"
   ```
   
   See [SSM-SETUP.md](./SSM-SETUP.md) for more details.

2. **Configuration Files**:

   **samconfig.toml**: This file will be auto-generated during your first `sam deploy --guided`. You can copy from the example:
   ```bash
   cp samconfig.toml.example samconfig.toml
   ```
   
   Or let SAM create it for you (recommended for first-time deployment).

   **env.json**: For local testing only
   ```json
   {
     "HazelFunction": {
       "ACCOUNT": "your-github-account",
       "REPOSITORY": "your-repo-name",
       "USE_LOCAL_ENV": "true"
     }
   }
   ```

## Deployment

### First-Time Deployment

1. **Create SSM Parameters** (see [SSM-SETUP.md](./SSM-SETUP.md) or the Configuration section above)

2. **Build the application**:
   ```bash
   npm run aws:build
   # or
   sam build
   ```

3. **Deploy with guided mode** (interactive):
   ```bash
   npm run aws:deploy
   # or
   sam deploy --guided
   ```

   You'll be prompted for:
   - Stack name (default: `hazel-update-server`)
   - AWS Region (e.g., `us-east-1`)
   - Parameter values (SSMParameterPrefix, Pre, Interval)
   - **Image Repository for HazelFunction**: Press Enter to let SAM create an ECR repository automatically
   - Confirmation for IAM role creation
   - Confirmation for various capabilities
   - Save configuration to samconfig.toml: Choose `Y`

   **Important**: When prompted for "Image Repository for HazelFunction", just press Enter. SAM will automatically create an ECR repository for you.

4. **Note the output URL**: After deployment, SAM will output the API URL:
   ```
   Outputs:
   HazelUrl: https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/Prod
   ```

### Subsequent Deployments

After the first deployment, you can use the fast deployment command:

```bash
npm run aws:deploy:fast
# or
sam build && sam deploy
```

This uses the configuration saved in `samconfig.toml`.

## Local Testing

### Test Locally with SAM

Start the API locally using SAM Local:

```bash
npm run aws:local
# or
sam local start-api --env-vars env.json
```

Then test with curl:
```bash
curl http://localhost:3000/
```

### Test with Node.js Server

Run a simple Node.js HTTP server locally:

```bash
ACCOUNT=your-account REPOSITORY=your-repo npm run dev:local
```

Then test:
```bash
curl http://localhost:8080/
```

## Monitoring and Logs

### View Lambda Logs

```bash
npm run aws:logs
# or
sam logs -n HazelFunction --stack-name hazel-update-server --tail
```

### CloudWatch Logs

You can also view logs in the AWS Console:
1. Navigate to CloudWatch → Log groups
2. Find `/aws/lambda/hazel-update-server-HazelFunction-xxxxx`

## Updating Configuration

### Update SSM Parameters

Configuration is stored in SSM Parameter Store. Update parameters without redeploying:

```bash
# Update a parameter
aws ssm put-parameter \
  --name "/sst/hazel/production/secrets/TOKEN" \
  --value "new-token-value" \
  --type "SecureString" \
  --overwrite
```

Changes take effect on the next Lambda cold start (typically within 15 minutes), or force restart by updating a dummy environment variable.

See [SSM-SETUP.md](./SSM-SETUP.md) for more details.

### Update Optional Environment Variables

For PRE, INTERVAL, or other non-SSM settings:

1. Update `samconfig.toml` with new parameter values
2. Redeploy:
   ```bash
   npm run aws:deploy:fast
   ```

## Using in Your Electron App

Update your Electron app to use the AWS endpoint:

```js
const { app, autoUpdater } = require('electron')

const server = 'https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/Prod'
const url = `${server}/update/${process.platform}/${app.getVersion()}`

autoUpdater.setFeedURL({ url })
```

## Cost Estimation

AWS Lambda pricing (as of 2024):
- **Free tier**: 1M requests/month + 400,000 GB-seconds compute time
- **After free tier**: $0.20 per 1M requests + $0.0000166667 per GB-second

For a typical Electron app with 10,000 users checking for updates daily:
- ~300,000 requests/month
- Well within free tier for most use cases

API Gateway HTTP API pricing:
- **Free tier**: None
- **Cost**: $1.00 per million requests

**Estimated monthly cost for 300K requests**: ~$0.30 (mostly API Gateway)

## Cleanup

To remove the deployment and all resources:

```bash
sam delete --stack-name hazel-update-server
```

Or via AWS Console:
1. Go to CloudFormation
2. Select `hazel-update-server` stack
3. Click "Delete"

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

The Lambda Web Adapter bridges API Gateway events to your existing Node.js HTTP server, requiring minimal code changes.

## Troubleshooting

### "Error: Invalid value for '--image-repositories'"

**Cause**: You have an old `samconfig.toml` with invalid ECR repository configuration.

**Solution**: Delete `samconfig.toml` and run `sam deploy --guided` again:
```bash
rm samconfig.toml
npm run aws:deploy
```

SAM will automatically create and manage the ECR repository during guided deployment.

### "Error: Unable to upload artifact" during deployment

Make sure Docker is running and you're logged into AWS ECR if required.

### "Error loading SSM parameters" or "Missing configuration properties"

**Causes**:
- SSM parameters don't exist
- Parameters are in a different AWS region
- IAM permissions issue

**Solutions**:
1. Verify SSM parameters exist:
   ```bash
   aws ssm get-parameters-by-path --path "/sst/hazel/production/secrets" --region us-east-1
   ```
2. Create missing parameters (see [SSM-SETUP.md](./SSM-SETUP.md))
3. Ensure parameters are in the same region as your Lambda function
4. Check Lambda execution role has SSM read permissions

### Cache not refreshing

Check the `INTERVAL` environment variable. Default is 15 minutes. For immediate refresh, restart the Lambda function or wait for the next invocation after the interval.

### Private repository not working

Ensure:
1. `TOKEN` SSM parameter is set with a valid GitHub personal access token
2. Token has `repo` scope permissions
3. Token parameter is created as `SecureString` type

## Migration from Vercel

If migrating from an existing Vercel deployment:

1. Deploy to AWS as described above
2. Update your Electron app to use the new AWS URL
3. Test thoroughly with a pre-release
4. Release the update to your users
5. Once confirmed working, you can remove the Vercel deployment

## Support

For issues specific to AWS deployment, check:
- AWS Lambda Web Adapter: https://github.com/awslabs/aws-lambda-web-adapter
- AWS SAM documentation: https://docs.aws.amazon.com/serverless-application-model/

For Hazel-specific issues, see the main README.md.
