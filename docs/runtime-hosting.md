# Runtime hosting and rollback

## Production

- Host: Windows Dev Kit 2023, running Ubuntu 26.04 ARM64 (not Windows/WSL).
- SSH: `windows-dev-kit`, user `andy`, port `2222`; tailnet name `andy-windows-dev-kit-2023.pigeon-justice.ts.net`.
- Public URL: `https://approach-runtime.andyfang.app`. Web and native client URLs do not change.
- Origin: `127.0.0.1:9191`; never bound to the public or LAN interface.
- System services: `approach-viz-runtime.service` and `approach-viz-tunnel.service`, enabled at boot and restarted on failure.
- Runtime: `/usr/local/bin/approach-viz-runtime`.
- Source workspace: `/home/andy/services/approach-viz-runtime-workspace`.
- Storage: `/var/lib/approach-viz-runtime` (MRMS snapshots plus `traffic-store.db` and its WAL).
- Limits: 200% CPU, 14 GiB memory high-water, 16 GiB maximum, 4 GiB swap maximum.
- Host-only credentials: `/etc/approach-viz-runtime/aws.env` and `r2-publish.env`, root-owned mode `0600`. These are loaded by systemd, not installed into Andy's interactive AWS profile.
- Dedicated Cloudflare Tunnel: `approach-viz-runtime-dev-kit`, UUID `ad4da2ff-c6b6-47b1-a890-d341dbe34103`. Its config and narrow connector credential are under `/home/andy/.local/share/approach-viz-tunnel/`; the account-wide Cloudflare certificate is not copied to the Dev Kit.

The existing AWS queue is deliberately retained, including its historical name:

```text
https://sqs.us-east-1.amazonaws.com/360132101973/approach-viz-mrms-oci-useast-arm-4
```

Only one production consumer/publisher should run. Do not create a second consumer on this queue during staging. R2 publishing still uses the existing weather bucket and prefix.

The migration reused the exact deployed ARM64 binary, not a new build (SHA-256 `6053d7f5bd3556ef75a4e16fdc10f37bb0113200d0548b5bef5502d99bf1dc83`), and copied the final stopped database/WAL plus snapshots. OCI's runtime service is stopped and disabled, and its Cloudflare ingress rule and `/runtime-v1` Funnel handler are removed. Other OCI routes/services remain in place. The old binary, storage, unit/drop-ins, and a baseline of the ingress config are retained for rollback under `/home/ubuntu/services/approach-viz-runtime-migration-backup` and their original paths.

The Dev Kit does not currently have the OCI Datadog agent or `ddprof` wrapper. Runtime logs remain in journald; Datadog host profiling/tracing is not migrated. Do not install OCI's profiler drop-in without first provisioning a local agent and checking the kernel profiler requirements.

## Deploy

The historical script filename remains supported. It discovers the SSH account's user, primary group, and home directory; overrides are available via `RUNTIME_REMOTE_USER`, `RUNTIME_REMOTE_GROUP`, and `RUNTIME_REMOTE_HOME`. Key-based SSH works without an SSH agent socket.

From the repository root on a machine with Cargo and a Linux ARM64 cross-build tool:

```bash
bash .agents/skills/runtime-deploy-oci/scripts/deploy_runtime_with_server_queue.sh windows-dev-kit
```

Or provide the queue explicitly:

```bash
RUNTIME_MRMS_SQS_QUEUE_URL='https://sqs.us-east-1.amazonaws.com/360132101973/approach-viz-mrms-oci-useast-arm-4' \
  RUNTIME_DEPLOY_BUILD_MODE=local-cross \
  scripts/runtime/deploy_oci.sh windows-dev-kit
```

The Dev Kit need not have a Rust toolchain when deploying a cross-built binary. `RUNTIME_LOCAL_CROSS_BINARY_PATH` selects an existing executable artifact. A supplied artifact keeps its own embedded build metadata; the script cannot stamp an already-built binary.

Cloudflare is the default ingress mode, and the script does not edit tunnel configuration or DNS. It checks the public `/healthz` after its remote local checks. Set `RUNTIME_PUBLIC_BASE_URL` for a different endpoint, or explicitly set it to an empty string for a private staging deployment. Legacy Funnel provisioning is opt-in with `RUNTIME_DEPLOY_EXPOSURE=tailscale-funnel`; never enable it as part of an ordinary production deploy.

Validate through the actual production URL:

```bash
bash .agents/skills/runtime-validate-live/scripts/smoke_runtime_endpoints.sh
npm run test:integration:runtime
ssh windows-dev-kit 'systemctl is-active approach-viz-runtime approach-viz-tunnel; systemctl is-enabled approach-viz-runtime approach-viz-tunnel'
```

Read `/v1/meta` twice across a scan interval, and check the Dev Kit journal for both `Ingested MRMS scan` and `Published MRMS scan ... to R2`. A restored snapshot or `sqsEnabled: true` alone does not prove ingestion or publishing works.

## Rollback to OCI

Use this only after a production regression; do not run both queue consumers at once.

1. Stop the Dev Kit runtime: `ssh windows-dev-kit 'sudo systemctl disable --now approach-viz-runtime'`. Keep its tunnel running until the replacement is ready.
2. On OCI, restore the runtime hostname rule from `/home/ubuntu/services/approach-viz-runtime-migration-backup/cloudflared-config.yml` into the current `~/.cloudflared/config.yml`, preserving any unrelated ingress changes since the migration. Validate with `cloudflared tunnel ingress validate`, then restart only the user `cloudflared-tunnel.service`.
3. Re-enable and start the retained OCI runtime: `sudo systemctl enable --now approach-viz-runtime`. Wait for local health, a fresh scan, and traffic. Its retained snapshot may be stale; a new scan must catch up before declaring rollback complete.
4. On the host holding the Cloudflare management certificate, point the public hostname back to OCI. Use an explicit empty config file containing `{}` (not the default config, whose `tunnel:` can override the positional target):

   ```bash
   cloudflared tunnel --config /path/to/empty-config.yml route dns --overwrite-dns \
     3ebd3e01-d261-4079-8f84-3e570283a6a4 approach-runtime.andyfang.app
   ```

5. Read the exact DNS record back through the Cloudflare API, then repeat public weather, echo-top, traffic/history, and R2 freshness checks. DNS/edge propagation can briefly return 502 after a change; verify the real response and matching destination journal, not just the DNS write.
6. Once public routing is verified, disable the Dev Kit tunnel if no longer needed. There is no need to restore the obsolete OCI Funnel route.

Do not automatically copy newer traffic SQLite files into an active runtime during rollback. If preserving the latest trails is necessary, stop both runtimes first and transfer the database together with its WAL/SHM, or make an online SQLite backup under an explicit pinned read transaction. An unpinned online backup can repeatedly restart on a busy writer and fail to finish.
