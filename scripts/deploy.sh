#!/usr/bin/env bash
set -euo pipefail

# Builds the Lambda image in a fixed format, pushes it to ECR and deploys it
# with CloudFormation, then checks the endpoint and rolls back if it fails.
#
# The image is built here rather than by `sam build`: SAM's push from Docker
# Desktop's containerd image store produced images Lambda could not start
# (Runtime.InvalidEntrypoint), even for unchanged code.
#
# Usage: scripts/deploy.sh [--yes | --dry-run] [stack-name] [Parameter=Value ...]
#   --yes      deploys the change set without asking (for CI)
#   --dry-run  shows the change set, then deletes it; the image is still pushed
#   stack-name defaults to hazel-update-server
# Needs AWS credentials (an MFA session locally, see README-AWS.md), Docker
# and a clean git tree.

cd "$(dirname "$0")/.."
mode=ask
case "${1:-}" in
  --yes) mode=yes; shift ;;
  --dry-run) mode=dry-run; shift ;;
esac
stack="${1:-hazel-update-server}"
shift || true
region="${AWS_REGION:-eu-west-2}"
repository="${ECR_REPOSITORY:-hazel-update-server}"

if [ -n "$(git status --porcelain)" ]; then
  echo 'Commit your changes first: the image is tagged with the commit.' >&2
  exit 1
fi

account="$(aws sts get-caller-identity --query Account --output text)"
registry="$account.dkr.ecr.$region.amazonaws.com"
tag="$(git rev-parse --short=12 HEAD)"

aws ecr describe-repositories --repository-names "$repository" --region "$region" >/dev/null 2>&1 ||
  aws ecr create-repository --repository-name "$repository" --region "$region" >/dev/null
aws ecr get-login-password --region "$region" |
  docker login --username AWS --password-stdin "$registry" >/dev/null

# Docker v2 media types, one platform, no attestations: the format Lambda runs
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  --output "type=registry,name=$registry/$repository:$tag,oci-mediatypes=false" .

# Deploy by digest: Lambda pins whatever a tag pointed to at deploy time, so a
# rebuild under the same tag would otherwise leave the old image running
digest="$(aws ecr describe-images --repository-name "$repository" --region "$region" \
  --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text)"
image="$registry/$repository@$digest"

# What is running now, so a failed deploy can restore both image and parameters
previous=''
previous_parameters=()
function_name="$(aws cloudformation describe-stack-resource --stack-name "$stack" \
  --logical-resource-id HazelFunction --region "$region" \
  --query StackResourceDetail.PhysicalResourceId --output text 2>/dev/null || true)"
if [ -n "$function_name" ]; then
  previous="$(aws lambda get-function --function-name "$function_name" --region "$region" \
    --query Code.ResolvedImageUri --output text)"
  while IFS=$'\t' read -r key value; do
    if [ "$key" != ImageUri ]; then
      previous_parameters+=("$key=$value")
    fi
  done < <(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
    --query 'Stacks[0].Parameters[].[ParameterKey,ParameterValue]' --output text)
fi

deploy() {
  aws cloudformation deploy --template-file template.yaml --stack-name "$stack" \
    --region "$region" --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
    --no-fail-on-empty-changeset --parameter-overrides "ImageUri=$1" "${@:2}"
}

output="$(deploy "$image" "$@" --no-execute-changeset)"
change_set="$(grep -o 'arn:aws:cloudformation:[^ ]*:changeSet/[^ ]*' <<<"$output" || true)"
if [ -z "$change_set" ]; then
  echo "$output"
  exit 0
fi

aws cloudformation describe-change-set --change-set-name "$change_set" --region "$region" \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' \
  --output table
echo "Current image: ${previous:-none}"
case "$mode" in
  yes) answer=y ;;
  dry-run) answer=n ;;
  *) read -r -p "Deploy $tag ($image) to $stack? [y/N] " answer ;;
esac
if [ "$answer" != y ]; then
  aws cloudformation delete-change-set --change-set-name "$change_set" --region "$region"
  if [ "$mode" = dry-run ]; then
    echo "Dry run: change set deleted, $stack unchanged."
    exit 0
  fi
  echo 'Cancelled.'
  exit 1
fi

aws cloudformation execute-change-set --change-set-name "$change_set" --region "$region"
if [ -n "$function_name" ]; then
  aws cloudformation wait stack-update-complete --stack-name "$stack" --region "$region"
else
  aws cloudformation wait stack-create-complete --stack-name "$stack" --region "$region"
fi

url="$(aws cloudformation describe-stacks --stack-name "$stack" --region "$region" \
  --query "Stacks[0].Outputs[?OutputKey=='HazelUrl'].OutputValue" --output text)"

# Only a 200 proves the new image loaded release data. A 503 can mean a bad
# token or SSM config as well as a GitHub outage, so it fails the check; during
# an outage the deploy rolls back and can be retried. The first request is a
# cold start that loads releases from GitHub, so allow a few attempts.
healthy() {
  local status
  for _ in 1 2 3; do
    status="$(curl -s -o /dev/null --max-time 30 -w '%{http_code}' "$url" || true)"
    if [ "$status" = 200 ]; then
      return 0
    fi
    sleep 5
  done
  echo "$url returned $status" >&2
  return 1
}

if healthy; then
  echo "Deployed $tag ($image) to $stack: $url"
  exit 0
fi

echo "Smoke check failed after deploying $image to $stack." >&2
if [ -z "$previous" ]; then
  echo 'No previous image to roll back to.' >&2
  exit 1
fi
echo "Rolling back to $previous with ${previous_parameters[*]-no parameters}" >&2
deploy "$previous" ${previous_parameters[@]+"${previous_parameters[@]}"}
if healthy; then
  echo "Rolled back to $previous" >&2
else
  echo "Rollback is deployed but still failing the smoke check: investigate now." >&2
fi
exit 1
