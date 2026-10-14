# Glasstrack API

JSON over HTTPS at `/api/v1`. The web app uses the same API.

## Authentication

Create a personal API token in **Settings → API tokens**. Send it as a bearer token:

```sh
curl -H "Authorization: Bearer gt_..." https://glasstrack.example.com/api/v1/w/acme/issues
```

A token acts as you, inside the one workspace it was created in. It can't create other tokens or manage webhooks and integrations. Revoke it any time; tokens can also expire.

Errors look like `{"error": {"code": "not_found", "message": "Issue not found"}}`. Rate limit: 600 requests a minute per user (HTTP 429 with `Retry-After`).

## Endpoints

Workspace endpoints live under `/api/v1/w/:slug`. Issues can be addressed by key (`ENG-12`) or id.

| Method | Path | |
|---|---|---|
| GET | `/me` | You and your workspaces |
| GET | `/w/:slug/teams` · `/states` · `/labels` · `/cycles` · `/members` | Workspace structure |
| GET | `/w/:slug/issues?team=&status=&assignee=me&label=&priority=1,2&cycle=active&q=` | List and filter (`limit`, `offset`, `order=manual\|priority\|updated\|created`) |
| POST | `/w/:slug/issues` | Create: `{teamId, title, description?, statusId?, priority?, assigneeId?, labelIds?, dueDate?, estimate?, parentId?, cycleId?}` |
| GET / PATCH / DELETE | `/w/:slug/issues/:ref` | Read (with sub-issues, links, attachments), update any field, delete |
| POST | `/w/:slug/issues/:ref/move` | `{statusId?, afterId?, beforeId?}` |
| GET / POST | `/w/:slug/issues/:ref/comments` | Markdown comments, `@handle` mentions |
| GET | `/w/:slug/issues/:ref/activity` | Full history |
| GET | `/w/:slug/search?q=` | Full-text search |
| POST | `/w/:slug/import` | Import (see below) |

## Webhooks

Admins add endpoints in **Settings → Webhooks**. Events: `issue.created`, `issue.updated`, `issue.deleted`, `comment.created`. Each delivery is a POST with:

- `Glasstrack-Event`: the event name
- `Glasstrack-Delivery`: a unique id (deduplicate on it)
- `Glasstrack-Signature`: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with your endpoint secret>`

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

Deliveries are sent after the change is saved, time out after 10 seconds, don't follow redirects, and are retried up to 5 times with backoff. Any 2xx response counts as delivered. An endpoint that fails 20 deliveries in a row is switched off. Hosted servers refuse endpoints on private networks.

## Importing from Linear, Jira and Trello

`POST /w/:slug/import` with `{source: "linear" | "jira" | "trello", teamId, content, dryRun?}`, where `content` is the export file's text:

- **Linear:** Settings → Import/export → Export CSV.
- **Jira:** Filters → Export → Export Excel CSV (all fields). Repeated Labels and Comment columns are read.
- **Trello:** Board menu → Print, export and share → Export as JSON. Lists become statuses.

Statuses are matched by name (missing ones are created with a guessed category), labels by name, people by email or name. Unmatched people are listed in the response. Up to 5,000 issues per import. Use `dryRun: true` to preview.

## GitHub

In **Settings → GitHub**, turn on the integration to get a webhook URL and secret. In your repository: Settings → Webhooks → Add webhook, content type `application/json`, the secret, and "Pull requests" events.

Mention an issue key (for example `ENG-12`) in a pull request's title, description or branch name to link it. When the pull request is merged, the issue moves to the team's first Done status (you can turn that off).
