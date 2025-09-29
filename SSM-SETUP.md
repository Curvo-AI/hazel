# SSM Parameter Store Setup

This guide explains how to set up AWS Systems Manager (SSM) Parameter Store for Hazel configuration.

## Overview

Hazel now loads sensitive configuration from AWS SSM Parameter Store instead of environment variables. This provides:

- ✅ **Secure secret storage** - Encrypted parameters with AWS KMS
- ✅ **Centralized configuration** - Manage secrets outside of code
- ✅ **Easy rotation** - Update secrets without redeploying
- ✅ **Audit trail** - Track parameter changes via CloudTrail

## Required SSM Parameters

Create the following SSM parameters in your AWS account:

| Parameter Path | Description | Required | Type |
|----------------|-------------|----------|------|
| `/sst/hazel/production/secrets/ACCOUNT` | GitHub account or organization name | Yes | String |
| `/sst/hazel/production/secrets/REPOSITORY` | GitHub repository name | Yes | String |
| `/sst/hazel/production/secrets/TOKEN` | GitHub personal access token | No* | SecureString |

*Required for private repositories

## Creating SSM Parameters

### Using AWS Console

1. Navigate to **AWS Systems Manager** → **Parameter Store**
2. Click **Create parameter**
3. For each parameter:
   - **Name**: Enter the full parameter path (e.g., `/sst/hazel/production/secrets/ACCOUNT`)
   - **Type**: 
     - Use `String` for ACCOUNT and REPOSITORY
     - Use `SecureString` for TOKEN (encrypted)
   - **Value**: Enter the corresponding value
   - Click **Create parameter**

### Using AWS CLI

Create all parameters with a single script:

```bash
#!/bin/bash

# Set your values here
GITHUB_ACCOUNT="your-github-account"
GITHUB_REPO="your-repo-name"
GITHUB_TOKEN="ghp_xxxxxxxxxxxx"  # Optional, for private repos
AWS_REGION="us-east-1"

# Create parameters
aws ssm put-parameter \
  --name "/sst/hazel/production/secrets/ACCOUNT" \
  --value "$GITHUB_ACCOUNT" \
  --type "String" \
  --region "$AWS_REGION"

aws ssm put-parameter \
  --name "/sst/hazel/production/secrets/REPOSITORY" \
  --value "$GITHUB_REPO" \
  --type "String" \
  --region "$AWS_REGION"

# Create TOKEN parameter (SecureString for encryption)
# Skip this if you have a public repository
aws ssm put-parameter \
  --name "/sst/hazel/production/secrets/TOKEN" \
  --value "$GITHUB_TOKEN" \
  --type "SecureString" \
  --region "$AWS_REGION"

echo "SSM parameters created successfully!"
```

### Using Terraform

```hcl
resource "aws_ssm_parameter" "hazel_account" {
  name  = "/sst/hazel/production/secrets/ACCOUNT"
  type  = "String"
  value = "your-github-account"
}

resource "aws_ssm_parameter" "hazel_repository" {
  name  = "/sst/hazel/production/secrets/REPOSITORY"
  type  = "String"
  value = "your-repo-name"
}

resource "aws_ssm_parameter" "hazel_token" {
  name  = "/sst/hazel/production/secrets/TOKEN"
  type  = "SecureString"
  value = "ghp_xxxxxxxxxxxx"
}
```

## Updating Parameters

### Using AWS CLI

```bash
aws ssm put-parameter \
  --name "/sst/hazel/production/secrets/TOKEN" \
  --value "new-token-value" \
  --type "SecureString" \
  --overwrite \
  --region us-east-1
```

### Using AWS Console

1. Navigate to Parameter Store
2. Select the parameter
3. Click **Edit**
4. Update the value
5. Click **Save changes**

**Note**: After updating parameters, the Lambda function will pick up new values on the next cold start (or you can manually restart it).

## Custom SSM Parameter Prefix

By default, Hazel looks for parameters under `/sst/hazel/production/secrets/`. To use a different prefix:

### Update SAM Template Parameter

In `samconfig.toml`:

```toml
parameter_overrides = [
  "SSMParameterPrefix=/my/custom/prefix",
  "Pre=",
  "Interval=15"
]
```

Or during deployment:

```bash
sam deploy --parameter-overrides SSMParameterPrefix=/my/custom/prefix
```

### Create Parameters with Custom Prefix

```bash
aws ssm put-parameter \
  --name "/my/custom/prefix/ACCOUNT" \
  --value "your-account" \
  --type "String"

aws ssm put-parameter \
  --name "/my/custom/prefix/REPOSITORY" \
  --value "your-repo" \
  --type "String"

aws ssm put-parameter \
  --name "/my/custom/prefix/TOKEN" \
  --value "your-token" \
  --type "SecureString"
```

## Verifying Parameters

### List all Hazel parameters

```bash
aws ssm get-parameters-by-path \
  --path "/sst/hazel/production/secrets" \
  --recursive \
  --region us-east-1
```

### Get specific parameter value

```bash
aws ssm get-parameter \
  --name "/sst/hazel/production/secrets/ACCOUNT" \
  --region us-east-1 \
  --query "Parameter.Value" \
  --output text
```

### Get encrypted parameter value

```bash
aws ssm get-parameter \
  --name "/sst/hazel/production/secrets/TOKEN" \
  --with-decryption \
  --region us-east-1 \
  --query "Parameter.Value" \
  --output text
```

## Local Development

For local testing, set `USE_LOCAL_ENV=true` to skip SSM and use local environment variables:

**env.json**:
```json
{
  "HazelFunction": {
    "ACCOUNT": "your-github-account",
    "REPOSITORY": "your-repo-name",
    "TOKEN": "",
    "USE_LOCAL_ENV": "true",
    "PORT": "8080"
  }
}
```

Then run:
```bash
npm run aws:local
```

Or for Node.js server:
```bash
USE_LOCAL_ENV=true ACCOUNT=your-account REPOSITORY=your-repo npm run dev:local
```

## IAM Permissions

The Lambda function automatically has permissions to read SSM parameters under the configured prefix. The SAM template includes:

```yaml
Policies:
  - Version: '2012-10-17'
    Statement:
      - Effect: Allow
        Action:
          - ssm:GetParameters
          - ssm:GetParameter
        Resource:
          - !Sub 'arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${SSMParameterPrefix}/*'
```

## Troubleshooting

### "Error loading SSM parameters: AccessDeniedException"

**Cause**: Lambda doesn't have permission to read SSM parameters.

**Solution**: Verify the SSM parameter prefix matches the one in your SAM template and redeploy.

### "No parameters returned from SSM"

**Cause**: Parameters don't exist or are in a different region.

**Solutions**:
1. Verify parameters exist: `aws ssm describe-parameters --region us-east-1`
2. Check parameter paths match exactly (case-sensitive)
3. Ensure you're creating parameters in the same region as your Lambda function

### "Missing SSM parameters: [list]"

**Cause**: Some required parameters are missing.

**Solution**: Create the missing parameters listed in the error message.

### Parameters not updating after change

**Cause**: Lambda is reusing a warm container with cached parameter values.

**Solutions**:
1. Wait for the Lambda to cold start naturally (usually within 15 minutes)
2. Update Lambda environment variable to force restart:
   ```bash
   aws lambda update-function-configuration \
     --function-name hazel-update-server-HazelFunction-xxxxx \
     --environment Variables={FORCE_RESTART=true}
   ```
3. Redeploy the function

## Security Best Practices

1. **Use SecureString for sensitive data**: Always use `SecureString` type for tokens and passwords
2. **Restrict IAM permissions**: Only grant access to the specific parameter paths needed
3. **Enable CloudTrail**: Monitor parameter access and changes
4. **Rotate tokens regularly**: Update GitHub tokens periodically
5. **Use least privilege**: Don't grant broader SSM permissions than necessary

## Cost

SSM Parameter Store pricing (as of 2024):

- **Standard parameters**: Free (up to 10,000 parameters)
- **Advanced parameters**: $0.05 per parameter per month
- **API calls**: Free for standard tier

For Hazel with 3 parameters, **the cost is $0.00/month**.

## Migration from Environment Variables

If migrating from environment variable configuration:

1. Create SSM parameters with your existing values
2. Deploy the updated Hazel version
3. Verify it works correctly
4. Remove old parameter overrides from `samconfig.toml`

The new version automatically falls back to environment variables if SSM parameters aren't available, so the migration is safe.
