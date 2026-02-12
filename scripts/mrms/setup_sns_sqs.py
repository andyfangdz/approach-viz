#!/usr/bin/env python3
"""Create/update SQS subscription for NOAA MRMS SNS notifications."""

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

    response = sns.subscribe(
        TopicArn=args.topic_arn,
        Protocol="sqs",
        Endpoint=queue_arn,
        Attributes={"RawMessageDelivery": "true"},
        ReturnSubscriptionArn=True,
    )

    output = {
        "region": args.region,
        "topicArn": args.topic_arn,
        "queueName": args.queue_name,
        "queueUrl": queue_url,
        "queueArn": queue_arn,
        "subscriptionArn": response.get("SubscriptionArn"),
    }
    print(json.dumps(output, indent=2))
    print()
    print("Set this for the Rust service:")
    print(f"MRMS_SQS_QUEUE_URL={queue_url}")


if __name__ == "__main__":
    main()
