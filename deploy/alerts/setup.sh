#!/usr/bin/env bash
# Creates (or updates) Glasstrack's alerting in AWS: health checks, alarms and
# Telegram notifications, with an optional AI first pass via GitHub.
# Safe to re-run. Needs the AWS CLI with credentials for the hosting account and:
#   INSTANCE_ID, HEALTH_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
#   optional: GITHUB_REPO (owner/name), GITHUB_TOKEN (can send repository_dispatch), BUDGET_NAME
set -euo pipefail
: "${INSTANCE_ID:?}" "${HEALTH_URL:?}" "${TELEGRAM_BOT_TOKEN:?}" "${TELEGRAM_CHAT_ID:?}"
REGION="${AWS_REGION:-eu-west-2}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
NAME=glasstrack-alerts
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
exists() { "$@" >/dev/null 2>&1; }

echo "1. Server can run read-only diagnostics through Systems Manager"
if ! exists aws iam get-role --role-name glasstrack-ec2-ssm; then
  aws iam create-role --role-name glasstrack-ec2-ssm --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name glasstrack-ec2-ssm --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam create-instance-profile --instance-profile-name glasstrack-ec2-ssm >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name glasstrack-ec2-ssm --role-name glasstrack-ec2-ssm
  sleep 10
fi
current=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' --output text)
if [[ "$current" == "None" ]]; then
  aws ec2 associate-iam-instance-profile --instance-id "$INSTANCE_ID" --iam-instance-profile Name=glasstrack-ec2-ssm >/dev/null
fi

echo "2. Lambda role"
if ! exists aws iam get-role --role-name "$NAME"; then
  aws iam create-role --role-name "$NAME" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$NAME" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 10
fi
aws iam put-role-policy --role-name "$NAME" --policy-name alerts --policy-document "{
  \"Version\":\"2012-10-17\",\"Statement\":[
    {\"Effect\":\"Allow\",\"Action\":\"cloudwatch:PutMetricData\",\"Resource\":\"*\",\"Condition\":{\"StringEquals\":{\"cloudwatch:namespace\":\"Glasstrack\"}}},
    {\"Effect\":\"Allow\",\"Action\":\"ssm:SendCommand\",\"Resource\":[\"arn:aws:ec2:$REGION:$ACCOUNT:instance/$INSTANCE_ID\",\"arn:aws:ssm:$REGION::document/AWS-RunShellScript\"]},
    {\"Effect\":\"Allow\",\"Action\":\"ssm:GetCommandInvocation\",\"Resource\":\"*\"}]}"

echo "3. Alert topic"
TOPIC=$(aws sns create-topic --name "$NAME" --query TopicArn --output text)
aws sns set-topic-attributes --topic-arn "$TOPIC" --attribute-name Policy --attribute-value "{
  \"Version\":\"2012-10-17\",\"Statement\":[
    {\"Effect\":\"Allow\",\"Principal\":{\"Service\":[\"cloudwatch.amazonaws.com\",\"budgets.amazonaws.com\"]},\"Action\":\"sns:Publish\",\"Resource\":\"$TOPIC\",
     \"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"$ACCOUNT\"}}}]}"

echo "4. Lambda function"
(cd "$HERE" && zip -q "$TMP/fn.zip" index.mjs)
jq -n --arg i "$INSTANCE_ID" --arg h "$HEALTH_URL" --arg t "$TELEGRAM_BOT_TOKEN" --arg c "$TELEGRAM_CHAT_ID" --arg r "${GITHUB_REPO:-}" --arg g "${GITHUB_TOKEN:-}" \
  '{Variables: {INSTANCE_ID: $i, HEALTH_URL: $h, TELEGRAM_BOT_TOKEN: $t, TELEGRAM_CHAT_ID: $c, GITHUB_REPO: $r, GITHUB_TOKEN: $g}}' > "$TMP/env.json"
VARS="file://$TMP/env.json"
if exists aws lambda get-function --function-name "$NAME"; then
  aws lambda update-function-code --function-name "$NAME" --zip-file "fileb://$TMP/fn.zip" >/dev/null
  aws lambda wait function-updated --function-name "$NAME"
  aws lambda update-function-configuration --function-name "$NAME" --environment "$VARS" --timeout 60 >/dev/null
else
  aws lambda create-function --function-name "$NAME" --runtime nodejs22.x --handler index.handler --timeout 60 --memory-size 256 \
    --role "arn:aws:iam::$ACCOUNT:role/$NAME" --zip-file "fileb://$TMP/fn.zip" --environment "$VARS" >/dev/null
fi
aws lambda wait function-active-v2 --function-name "$NAME"
FN=$(aws lambda get-function --function-name "$NAME" --query Configuration.FunctionArn --output text)
exists aws lambda add-permission --function-name "$NAME" --statement-id sns --action lambda:InvokeFunction --principal sns.amazonaws.com --source-arn "$TOPIC" || true
aws sns subscribe --topic-arn "$TOPIC" --protocol lambda --notification-endpoint "$FN" >/dev/null

echo "5. Schedules"
for spec in "health:rate(5 minutes)" "disk:rate(1 hour)"; do
  mode=${spec%%:*}; rate=${spec#*:}
  RULE=$(aws events put-rule --name "$NAME-$mode" --schedule-expression "$rate" --query RuleArn --output text)
  aws events put-targets --rule "$NAME-$mode" --targets "Id=fn,Arn=$FN,Input='{\"mode\":\"$mode\"}'" >/dev/null
  exists aws lambda add-permission --function-name "$NAME" --statement-id "events-$mode" --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn "$RULE" || true
done

echo "6. Alarms"
alarm() { aws cloudwatch put-metric-alarm --alarm-actions "$TOPIC" --ok-actions "$TOPIC" "$@"; }
alarm --alarm-name glasstrack-site-down --alarm-description "glasstrack.dev health check failing" \
  --namespace Glasstrack --metric-name HealthOk --statistic Minimum --period 300 --evaluation-periods 2 --datapoints-to-alarm 2 \
  --threshold 1 --comparison-operator LessThanThreshold --treat-missing-data breaching
alarm --alarm-name glasstrack-server-status-check --alarm-description "EC2 status check failed" \
  --namespace AWS/EC2 --metric-name StatusCheckFailed --dimensions "Name=InstanceId,Value=$INSTANCE_ID" --statistic Maximum \
  --period 60 --evaluation-periods 3 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching
alarm --alarm-name glasstrack-cpu-high --alarm-description "CPU above 85% for 15 minutes" \
  --namespace AWS/EC2 --metric-name CPUUtilization --dimensions "Name=InstanceId,Value=$INSTANCE_ID" --statistic Average \
  --period 300 --evaluation-periods 3 --threshold 85 --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching
alarm --alarm-name glasstrack-disk-high --alarm-description "Server disk above 85% full" \
  --namespace Glasstrack --metric-name DiskUsedPercent --statistic Maximum --period 3600 --evaluation-periods 1 \
  --threshold 85 --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching

if [[ -n "${BUDGET_NAME:-}" ]]; then
  echo "7. Budget alerts also go to the topic"
  aws budgets describe-notifications-for-budget --account-id "$ACCOUNT" --budget-name "$BUDGET_NAME" --query 'Notifications' --output json > "$TMP/n.json"
  for i in $(seq 0 $(( $(jq length "$TMP/n.json") - 1 ))); do
    n=$(jq -c ".[$i]" "$TMP/n.json")
    exists aws budgets create-subscriber --account-id "$ACCOUNT" --budget-name "$BUDGET_NAME" --notification "$n" \
      --subscriber "SubscriptionType=SNS,Address=$TOPIC" || true
  done
fi
echo "Done. Topic: $TOPIC"
