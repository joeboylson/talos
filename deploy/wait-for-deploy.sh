#!/bin/sh
# Waits for the service's newest deploy to finish, and fails if AWS rolled it
# back. A deploy takes about 10 minutes: AWS tries the new server on a little
# of the traffic first.
set -eu

service_arn="$1"
cluster="${service_arn%/*}"
cluster="${cluster##*/}"

sleep 20
deploy_arn=$(aws ecs list-service-deployments --cluster "$cluster" --service "$service_arn" \
  --query 'serviceDeployments[0].serviceDeploymentArn' --output text)

for _ in $(seq 1 60); do
  state=$(aws ecs describe-service-deployments --service-deployment-arns "$deploy_arn" \
    --query 'serviceDeployments[0].status' --output text)
  echo "Deploy: $state"
  case "$state" in
    SUCCESSFUL) exit 0 ;;
    PENDING | IN_PROGRESS) sleep 30 ;;
    *) exit 1 ;;
  esac
done

echo "Deploy still running after 30 minutes."
exit 1
