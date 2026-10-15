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
| GET | `/w/:slug/issues?team=&status=&assignee=me&label=&priority=1,2&cycle=active&q=&field=<fieldId>:<value>` | List and filter (`limit`, `offset`, `order=manual\|priority\|updated\|created`) |
| POST | `/w/:slug/issues` | Create: `{teamId, title, description?, statusId?, priority?, assigneeIds?, labelIds?, startDate?, dueDate?, estimate?, parentId?, cycleId?, fields?}` |
| GET / PATCH / DELETE | `/w/:slug/issues/:ref` | Read (with sub-issues, links, attachments), update any field, delete |
| POST | `/w/:slug/issues/:ref/move` | `{statusId?, afterId?, beforeId?}` |
| GET / POST | `/w/:slug/issues/:ref/comments` | Markdown comments, `@handle` mentions |
| GET | `/w/:slug/issues/:ref/activity` | Full history |
| GET | `/w/:slug/search?q=` | Full-text search |
| POST | `/w/:slug/import` | Import (see below) |
| GET / POST / PATCH / DELETE | `/w/:slug/fields[/:id]` | Custom fields (admins manage): `text`, `number`, `select`, `multi_select`, `date`, `checkbox`, `url`, `user` |
| GET / POST | `/w/:slug/issues/:ref/time` | Time entries: `{minutes, spentOn, note?}`; edit or delete with `/w/:slug/time/:id` |
| POST | `/w/:slug/issues/:ref/timer/start`, `/w/:slug/timer/stop` | Start or stop your timer (one per person; starting stops the last) |
| GET | `/w/:slug/time?from=&to=&team=&user=` | Time report with totals per person and per issue |
| GET / POST / PATCH / DELETE | `/w/:slug/templates[/:id]` | Issue templates |
| GET / POST / PATCH / DELETE | `/w/:slug/recurring[/:id]` | Recurring issues from a template: `{templateId, frequency, interval, weekdays, monthDay, hour, timezone, startsOn}` |
| GET | `/w/:slug/audit`, `/w/:slug/audit.csv` | Audit log (admins) |
| GET | `/w/:slug/relations?team=&type=blocks` | Links between issues (timeline dependencies) |
| GET | `/w/:slug/reports/overview?from=&to=&team=` | Cycle time and lead time (p50/p75/p90 hours), histogram, weekly created/completed/open, completed by person and label |
| GET | `/w/:slug/reports/cycles/:id` | Cycle burndown per day (points if the cycle uses estimates, otherwise issue count) |
| GET / POST / PATCH / DELETE | `/w/:slug/automations[/:id]` | Automation rules (admins); `GET .../:id/runs` for the last 50 runs |

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

## Single sign-on (OIDC)

Free on every Glasstrack server, self-hosted or hosted. Admins set it up in **Settings → Single sign-on** with their identity provider's issuer URL, a client ID and secret, and the company email domains. Register the app in the provider with the redirect URI shown there (`$APP_URL/api/v1/auth/sso/callback`) and the scopes `openid email profile`. Works with Okta, Microsoft Entra ID, Google Workspace, Keycloak, Authentik, Auth0 and any standard OpenID Connect provider.

- **Auto-join:** people from the listed domains join as members or guests on first sign-in. Without it, they need an invite.
- **SSO only:** members must sign in through SSO. Admins can still use other methods, so a broken setup can always be fixed.
- Client secrets are stored encrypted (AES-256-GCM, key derived from `APP_SECRET`).
- Self-hosted providers on a private network need `SSO_ALLOW_PRIVATE=true`.

SAML is not supported yet; most providers that offer SAML also offer OIDC.

## Automations

A rule is `{name, teamId?, enabled, trigger, triggerConfig, conditions, actions}`. Rules run right after the change that triggers them is saved. Changes made by a rule never trigger other rules, so rules can't loop.

- **Triggers:** `issue_created`, `status_changed` (optionally `toStatusIds` / `toCategories`), `label_added` (optionally `labelIds`), `priority_changed`, `assignees_changed`, `comment_added`, and two checked hourly: `due_date_passed` and `no_activity` (`days`). Scheduled triggers fire once per issue per occasion.
- **Conditions (all must match):** `statusIds`, `categories`, `priorities`, `labelIds` (any), `notLabelIds`, `assignee` (`"none"`, `"any"` or user ids), `fields` (`[{fieldId, value}]`).
- **Actions (up to 10, in order):** `set_status`, `set_priority`, `add_labels`, `remove_labels`, `set_assignees`, `add_assignees`, `set_field`, `comment`, `set_due_in_days`, `add_to_active_cycle`, `archive`.

A rule that fails is logged with its error and doesn't stop other rules.
