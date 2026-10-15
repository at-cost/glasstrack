# Deploying Glasstrack

How glasstrack.dev runs, and how to move it. Any VPS with Docker works the same way.

## Production layout

- **DNS and TLS:** Cloudflare, proxied. SSL mode "Full (strict)", HSTS on. The origin uses a Cloudflare Origin CA certificate (valid 15 years) in `/srv/glasstrack/tls`.
- **Server:** one Ubuntu 24.04 VM with Docker. The firewall accepts 80/443 only from [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) and SSH only from the operator's IP.
- **Stack:** `docker-compose.yml` plus `deploy/docker-compose.cloudflare.yml` (Caddy always on, app port not published). Compose project name `glasstrack` (set in the server `.env`), so volume names never change.
- **Server files:** `/srv/glasstrack/.env` (secrets, only on the server), `/srv/glasstrack/tls/`, `/srv/glasstrack/src/` (code, replaced on each deploy).
- **Email:** Amazon SES over SMTP port 587, domain verified with DKIM, bounces on `mail.glasstrack.dev`.
- **Files and backups:** an S3-compatible bucket (`STORAGE_DRIVER=s3`). Backups run daily at 03:15 UTC to `backups/`, kept 30 days.
- **Backup check:** a host cron restores the newest backup into a scratch database daily at 04:30 and logs the result: `journalctl -t glasstrack-restore-verify`.

## Deploy

From a clean checkout of `main`:

```sh
DEPLOY_HOST=ubuntu@<server-ip> DEPLOY_KEY=~/.ssh/<key> sh deploy/deploy.sh
```

It ships `git HEAD` (never uncommitted files), rebuilds on the server, runs migrations on start and waits until every container is healthy.

Useful on the server:

```sh
cd /srv/glasstrack/src
C="docker compose -f docker-compose.yml -f deploy/docker-compose.cloudflare.yml"
$C ps
$C logs -f app
$C exec -T app node dist/backup.js            # backup now
$C exec -T app node dist/restore-verify.js    # prove the newest backup restores
```

## Moving to another host (for example AWS to Hetzner)

About an hour of work and 15 to 30 minutes of downtime. Files stay in the bucket, so only the database moves.

1. **New server:** Ubuntu 24.04, install `docker.io docker-compose-v2 docker-buildx`, add the deploy user to the `docker` group, and open 80/443 to Cloudflare's ranges only and SSH to your IP.
2. **Copy config:** copy `/srv/glasstrack/.env` and `/srv/glasstrack/tls/` from the old server to the same paths (`scp`, keep mode 600).
3. **Deploy:** run `deploy.sh` against the new server. It starts with an empty database. Check `curl -k --resolve glasstrack.dev:443:127.0.0.1 https://glasstrack.dev/ready` on the server.
4. **Freeze the old server:** `$C stop app` on the old server, so nothing writes during the copy.
5. **Copy the database:**
   ```sh
   # old server
   $C exec -T postgres pg_dump -U glasstrack -Fc glasstrack > gt.dump
   # copy gt.dump to the new server, then there:
   $C stop app
   $C exec -T postgres pg_restore -U glasstrack -d glasstrack --clean --if-exists < gt.dump
   $C start app
   ```
6. **Switch DNS:** in Cloudflare, change the `glasstrack.dev` A record to the new IP. It is proxied, so the switch takes effect in seconds.
7. **Check:** sign in, open an issue, and run `restore-verify` on the new server. Add the restore-check cron (see the old server's `crontab -l`).
8. **Clean up:** after a few days, stop and delete the old server. Release its IP and delete its disk only once you are sure.

If files are on the old server's disk instead of a bucket, also `rsync` the `appdata` volume's `/data/files` before step 6.
