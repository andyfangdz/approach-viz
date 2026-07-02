#!/usr/bin/env python3
"""Create/update SQS subscription for NOAA MRMS SNS notifications.

Idempotent: safe to re-run. On every run it (re)applies the MessageBody
filter policy to the live subscription via ``sns:SetSubscriptionAttributes``
so only ``CONUS/MergedReflectivityQC_00.50/`` S3 events are forwarded to SQS
(the runtime's only ingest trigger). Without this, an already-existing
subscription keeps forwarding all ~241 MRMS products — ~240x unnecessary SQS
API calls and cost.

Required IAM permissions for the invoking principal: ``sqs:CreateQueue``,
``sqs:GetQueueAttributes``, ``sqs:SetQueueAttributes``, ``sns:Subscribe``,
and ``sns:SetSubscriptionAttributes``.
"""

from __future__ import annotations

import argparse
import json

import boto3


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
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    sqs = boto3.client("sqs", region_name=args.region)
    sns = boto3.client("sns", region_name=args.region)

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

    # Only forward S3 notifications for the base-level reflectivity product.
    # Without this filter the queue receives all ~241 MRMS products, adding
    # ~240x unnecessary SQS API calls (and cost).
    filter_policy = json.dumps(
        {
            "Records": {
                "s3": {
                    "object": {
                        "key": [
                            {"prefix": "CONUS/MergedReflectivityQC_00.50/"}
                        ]
                    }
                }
            }
        }
    )

    subscription_attributes = {
        "RawMessageDelivery": "true",
        "FilterPolicy": filter_policy,
        "FilterPolicyScope": "MessageBody",
    }

    response = sns.subscribe(
        TopicArn=args.topic_arn,
        Protocol="sqs",
        Endpoint=queue_arn,
        Attributes=subscription_attributes,
        ReturnSubscriptionArn=True,
    )
    subscription_arn = response.get("SubscriptionArn")

    # `sns.subscribe` only applies `Attributes` when it CREATES the
    # subscription. For an already-existing subscription (the common case when
    # re-running this script) it returns the existing ARN and silently ignores
    # the attributes — so a subscription created before the filter policy keeps
    # forwarding all ~241 MRMS products, inflating SQS API charges ~240x.
    # Explicitly (re)apply the attributes so the live subscription actually
    # picks up the filter without manual AWS console work.
    if subscription_arn and subscription_arn != "PendingConfirmation":
        for attribute_name, attribute_value in subscription_attributes.items():
            sns.set_subscription_attributes(
                SubscriptionArn=subscription_arn,
                AttributeName=attribute_name,
                AttributeValue=attribute_value,
            )

    output = {
        "region": args.region,
        "topicArn": args.topic_arn,
        "queueName": args.queue_name,
        "queueUrl": queue_url,
        "queueArn": queue_arn,
        "subscriptionArn": subscription_arn,
        "filterPolicyApplied": subscription_arn not in (None, "PendingConfirmation"),
    }
    print(json.dumps(output, indent=2))
    print()
    if output["filterPolicyApplied"]:
        print(
            "Applied MessageBody filter policy (CONUS/MergedReflectivityQC_00.50/ only) "
            "to the live subscription; all other MRMS products are no longer forwarded to SQS."
        )
    else:
        print(
            "WARNING: subscription is pending confirmation; filter policy not applied. "
            "Re-run once the subscription is confirmed."
        )
    print()
    print("Set this for the Rust runtime service:")
    print(f"RUNTIME_MRMS_SQS_QUEUE_URL={queue_url}")
    print("(legacy alias still supported: MRMS_SQS_QUEUE_URL)")


if __name__ == "__main__":
    main()
