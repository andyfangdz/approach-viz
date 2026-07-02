#!/usr/bin/env python3
"""Create/update the SQS subscription for NOAA MRMS SNS notifications.

The NOAA MRMS topic publishes S3 notifications for all ~241 MRMS products.
The runtime only needs `CONUS/MergedReflectivityQC_00.50/` keys as ingest
triggers, so the subscription carries a payload-based SNS filter policy.
Every delivered message is a billed SQS request, so an unfiltered
subscription costs ~240x more than a filtered one.

IMPORTANT: `sns.subscribe` does NOT update attributes on an existing
subscription — that is how the live queue kept receiving the unfiltered
firehose after the filter policy was first added here. This script now
always applies attributes via `set_subscription_attributes` and then
verifies the live filter policy, failing loudly on mismatch.

It also audits for stale resources that silently bill per SNS delivery:
subscriptions owned by this account on the MRMS topic that point at
anything other than the active queue, and leftover `approach-viz*` queues.
Use `--cleanup-stale-subscriptions` / `--delete-stale-queues` to remove
them.
"""

from __future__ import annotations

import argparse
import json
import sys

import boto3
from botocore.exceptions import ClientError


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--region",
        default="us-east-1",
        help="AWS region for SNS/SQS resources (default: us-east-1)",
    )
    parser.add_argument(
        "--topic-arn",
        default="arn:aws:sns:us-east-1:123901341784:NewMRMSObject",
        help="MRMS SNS topic ARN",
    )
    parser.add_argument(
        "--queue-name",
        default="approach-viz-mrms-oci-useast-arm-4",
        help="SQS queue name to create/update",
    )
    parser.add_argument(
        "--message-retention-seconds",
        type=int,
        default=4 * 24 * 60 * 60,
        help="SQS retention in seconds (default: 4 days)",
    )
    parser.add_argument(
        "--visibility-timeout-seconds",
        type=int,
        default=120,
        help="SQS visibility timeout in seconds",
    )
    parser.add_argument(
        "--wait-time-seconds",
        type=int,
        default=20,
        help="SQS long-poll wait time in seconds",
    )
    parser.add_argument(
        "--audit-only",
        action="store_true",
        help="Skip queue/subscription setup; only verify the active "
        "subscription filter and report stale resources (read-only)",
    )
    parser.add_argument(
        "--cleanup-stale-subscriptions",
        action="store_true",
        help="Unsubscribe this account's MRMS-topic subscriptions that do "
        "not point at the active queue (each one bills per delivery)",
    )
    parser.add_argument(
        "--delete-stale-queues",
        action="store_true",
        help="Delete leftover approach-viz MRMS SQS queues other than the "
        "active queue",
    )
    parser.add_argument(
        "--stale-queue-prefix",
        default="approach-viz",
        help="Queue-name prefix used to discover stale MRMS queues "
        "(default: approach-viz)",
    )
    args = parser.parse_args()
    if args.audit_only and (args.cleanup_stale_subscriptions or args.delete_stale_queues):
        parser.error(
            "--audit-only is strictly read-only and cannot be combined with "
            "--cleanup-stale-subscriptions or --delete-stale-queues; drop "
            "--audit-only to run cleanup"
        )
    return args


# Only forward S3 notifications for the base-level reflectivity product.
# Without this filter the queue receives all ~241 MRMS products, and every
# delivery is a billed SQS request (~240x unnecessary cost).
FILTER_POLICY = {
    "Records": {
        "s3": {"object": {"key": [{"prefix": "CONUS/MergedReflectivityQC_00.50/"}]}}
    }
}

SUBSCRIPTION_ATTRIBUTES = {
    "RawMessageDelivery": "true",
    "FilterPolicy": json.dumps(FILTER_POLICY),
    "FilterPolicyScope": "MessageBody",
}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def iam_hint(error: ClientError, action: str) -> None:
    code = error.response.get("Error", {}).get("Code", "")
    if code in ("AuthorizationError", "AccessDenied", "AccessDeniedException"):
        fail(
            f"{error}\n"
            f"The current IAM principal is missing `{action}`. Grant it "
            "(e.g. on the oci-sns-sqs-mrms IAM user) and re-run."
        )
    raise error


def ensure_queue(sqs, args: argparse.Namespace) -> tuple[str, str]:
    queue_url = sqs.create_queue(
        QueueName=args.queue_name,
        Attributes={
            "ReceiveMessageWaitTimeSeconds": str(args.wait_time_seconds),
            "VisibilityTimeout": str(args.visibility_timeout_seconds),
            "MessageRetentionPeriod": str(args.message_retention_seconds),
        },
    )["QueueUrl"]

    queue_arn = sqs.get_queue_attributes(
        QueueUrl=queue_url,
        AttributeNames=["QueueArn"],
    )["Attributes"]["QueueArn"]

    policy = {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "AllowNOAAMRMSSNSPublish",
                "Effect": "Allow",
                "Principal": {"Service": "sns.amazonaws.com"},
                "Action": "sqs:SendMessage",
                "Resource": queue_arn,
                "Condition": {"ArnEquals": {"aws:SourceArn": args.topic_arn}},
            }
        ],
    }
    sqs.set_queue_attributes(
        QueueUrl=queue_url,
        Attributes={"Policy": json.dumps(policy)},
    )
    return queue_url, queue_arn


def find_own_topic_subscriptions(sns, topic_arn: str) -> list[dict]:
    """List this account's subscriptions to the (externally owned) topic.

    `list_subscriptions_by_topic` needs permission on NOAA's topic, so we
    paginate our own subscriptions instead.
    """
    subscriptions = []
    try:
        for page in sns.get_paginator("list_subscriptions").paginate():
            for subscription in page.get("Subscriptions", []):
                if subscription.get("TopicArn") == topic_arn:
                    subscriptions.append(subscription)
    except ClientError as error:
        iam_hint(error, "sns:ListSubscriptions")
    return subscriptions


def ensure_subscription(sns, topic_arn: str, queue_arn: str) -> str:
    # Subscribe without attributes: idempotently returns the existing
    # subscription ARN (passing changed attributes here would raise
    # InvalidParameter instead of updating them).
    try:
        subscription_arn = sns.subscribe(
            TopicArn=topic_arn,
            Protocol="sqs",
            Endpoint=queue_arn,
            ReturnSubscriptionArn=True,
        )["SubscriptionArn"]
    except ClientError as error:
        iam_hint(error, "sns:Subscribe")

    for name, value in SUBSCRIPTION_ATTRIBUTES.items():
        try:
            sns.set_subscription_attributes(
                SubscriptionArn=subscription_arn,
                AttributeName=name,
                AttributeValue=value,
            )
        except ClientError as error:
            iam_hint(error, "sns:SetSubscriptionAttributes")
    return subscription_arn


def verify_subscription(sns, subscription_arn: str) -> None:
    try:
        attributes = sns.get_subscription_attributes(
            SubscriptionArn=subscription_arn
        )["Attributes"]
    except ClientError as error:
        iam_hint(error, "sns:GetSubscriptionAttributes")

    live_filter = attributes.get("FilterPolicy")
    if not live_filter:
        fail(
            f"Subscription {subscription_arn} has NO FilterPolicy applied — "
            "it receives all ~241 MRMS products and bills one SQS request "
            "per delivery."
        )
    if json.loads(live_filter) != FILTER_POLICY:
        fail(
            f"Subscription {subscription_arn} FilterPolicy does not match "
            f"the expected policy.\n  live:     {live_filter}\n"
            f"  expected: {json.dumps(FILTER_POLICY)}"
        )
    if attributes.get("FilterPolicyScope") != "MessageBody":
        fail(
            f"Subscription {subscription_arn} FilterPolicyScope is "
            f"{attributes.get('FilterPolicyScope')!r}, expected 'MessageBody' "
            "(the S3 key lives in the message body, not attributes)."
        )
    print(f"Verified live filter policy on {subscription_arn}")


def audit_stale_resources(
    sns, sqs, args: argparse.Namespace, active_queue_arn: str | None
) -> None:
    print("\n=== Stale-resource audit ===")

    stale_subscriptions = [
        subscription
        for subscription in find_own_topic_subscriptions(sns, args.topic_arn)
        if subscription.get("Endpoint") != active_queue_arn
    ]
    if stale_subscriptions:
        for subscription in stale_subscriptions:
            arn = subscription["SubscriptionArn"]
            print(
                f"STALE subscription -> {subscription.get('Endpoint')}\n"
                f"  {arn}\n"
                "  Every MRMS notification delivered here is a billed SQS "
                "request, even if nothing consumes the queue."
            )
            if args.cleanup_stale_subscriptions:
                try:
                    sns.unsubscribe(SubscriptionArn=arn)
                    print("  -> unsubscribed")
                except ClientError as error:
                    iam_hint(error, "sns:Unsubscribe")
        if not args.cleanup_stale_subscriptions:
            print("Re-run with --cleanup-stale-subscriptions to remove these.")
    else:
        print("No stale MRMS-topic subscriptions owned by this account.")

    queue_urls = []
    try:
        for page in sqs.get_paginator("list_queues").paginate(
            QueueNamePrefix=args.stale_queue_prefix
        ):
            queue_urls.extend(page.get("QueueUrls", []))
    except ClientError as error:
        iam_hint(error, "sqs:ListQueues")
    stale_queue_urls = [
        url for url in queue_urls if url.rsplit("/", 1)[-1] != args.queue_name
    ]
    if stale_queue_urls:
        for url in stale_queue_urls:
            print(f"STALE queue: {url}")
            if args.delete_stale_queues:
                try:
                    sqs.delete_queue(QueueUrl=url)
                    print("  -> deleted")
                except ClientError as error:
                    iam_hint(error, "sqs:DeleteQueue")
        if not args.delete_stale_queues:
            print("Re-run with --delete-stale-queues to delete these.")
    else:
        print(f"No stale '{args.stale_queue_prefix}*' queues.")


def main() -> None:
    args = parse_args()
    sqs = boto3.client("sqs", region_name=args.region)
    sns = boto3.client("sns", region_name=args.region)

    active_queue_arn: str | None = None
    if args.audit_only:
        try:
            queue_url = sqs.get_queue_url(QueueName=args.queue_name)["QueueUrl"]
            active_queue_arn = sqs.get_queue_attributes(
                QueueUrl=queue_url, AttributeNames=["QueueArn"]
            )["Attributes"]["QueueArn"]
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            if code != "QueueDoesNotExist":
                raise
            print(f"Active queue {args.queue_name} does not exist.")
        if active_queue_arn:
            for subscription in find_own_topic_subscriptions(sns, args.topic_arn):
                if subscription.get("Endpoint") == active_queue_arn:
                    verify_subscription(sns, subscription["SubscriptionArn"])
                    break
            else:
                print(
                    f"WARNING: no subscription found for {active_queue_arn}; "
                    "the runtime is relying on S3 bootstrap polling only."
                )
        audit_stale_resources(sns, sqs, args, active_queue_arn)
        return

    queue_url, active_queue_arn = ensure_queue(sqs, args)
    subscription_arn = ensure_subscription(sns, args.topic_arn, active_queue_arn)
    verify_subscription(sns, subscription_arn)
    audit_stale_resources(sns, sqs, args, active_queue_arn)

    output = {
        "region": args.region,
        "topicArn": args.topic_arn,
        "queueName": args.queue_name,
        "queueUrl": queue_url,
        "queueArn": active_queue_arn,
        "subscriptionArn": subscription_arn,
    }
    print()
    print(json.dumps(output, indent=2))
    print()
    print("Set this for the Rust runtime service:")
    print(f"RUNTIME_MRMS_SQS_QUEUE_URL={queue_url}")
    print("(legacy alias still supported: MRMS_SQS_QUEUE_URL)")


if __name__ == "__main__":
    main()
