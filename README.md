# kommo-verify

Glue service between **@FounderCircleAdminBot** (Telegram), **Kommo** (subdomain `fahadriazex1`,
Founder Circle pipeline `13228919`) and **Supabase**.

It relays Telegram updates into Kommo's Salesbot, stamps the lead with the Telegram identity and
traffic source, checks Founder Circle channel membership, and mirrors everything Kommo knows about
a lead into the Supabase `leads` table.

It also still serves the two Weex checks used by the older funnel (`/verify/registered`,
`/verify/deposited`) — those are untouched.

## Flow

1. User opens `t.me/FounderCircleAdminBot?start=instagram`.
2. Telegram POSTs the update to `POST /webhook/telegram`.
3. The service forwards it to Kommo's Telegram hook (`KOMMO_TG_WEBHOOK`), rewriting `/start …` to
   `Hi` so the Salesbot starts cleanly.
4. It resolves the Kommo lead, patches `Telegram User ID`, `Telegram Username` and
   `Source Platform` onto it, and inserts/updates the Supabase row.
5. The Salesbot asks its six questions and writes the answers onto the **contact**. Kommo's
   "contact added/updated" webhook hits `POST /webhook/contact`, which copies name, phone, email,
   country, age bracket and interest into Supabase.
6. The Salesbot calls `POST /verify/channel`; the service asks Telegram `getChatMember` and answers
   the bot with `joined` / `not_joined`.
7. Kommo moves the lead to **Joined Channel**; `POST /webhook/stage` records the stage and the
   `joined_at` / `lost_at` milestones. Telegram `chat_member` updates on the channel keep
   `in_channel` honest even when someone leaves later.

## Endpoints

| Endpoint | Called by | What it does |
|---|---|---|
| `POST /webhook/telegram` | Telegram | Forwards updates to Kommo, stamps the lead, upserts Supabase, handles `chat_member` join/leave |
| `POST /webhook/contact` | Kommo (contact added / updated) | Syncs the Salesbot's contact answers + tags into Supabase |
| `POST /webhook/stage` | Kommo (lead status changed) | Syncs `kommo_stage`, sets `joined_at` / `lost_at` |
| `POST /webhook/message` | Kommo (incoming message) | Keyword → tag rules on the lead |
| `POST /verify/channel` | Kommo Salesbot (`widget_request`) | Telegram channel membership via `getChatMember` |
| `POST /verify/registered` | Kommo Salesbot | Weex UID exists under the affiliate account |
| `POST /verify/deposited` | Kommo Salesbot | Weex UID has deposited |
| `GET /health` | Railway | `ok` |

Every endpoint answers HTTP 200 within Kommo's 2-second budget and does the real work afterwards.

### Status values returned to the Salesbot

| Endpoint | Status values |
|---|---|
| `/verify/channel` | `joined` / `not_joined` / `error` |
| `/verify/registered` | `verified` / `not_found` / `error` |
| `/verify/deposited` | `deposited` / `no_deposit` / `error` |

## Environment variables

The service refuses to start (exit 1) if any of the first six are missing.

| Var | Required | What it is |
|---|---|---|
| `KOMMO_TOKEN` | yes | Long-lived Kommo access token for `fahadriazex1` |
| `KOMMO_TG_WEBHOOK` | yes | Kommo's Telegram hook URL for @FounderCircleAdminBot. **Contains the bot token — secret.** |
| `BOT_TOKEN` | yes | @FounderCircleAdminBot token |
| `CHANNEL_ID` | yes | Founder Circle numeric id, starts with `-100` |
| `SUPABASE_URL` | yes | `https://<project>.supabase.co` |
| `SUPABASE_KEY` | yes | Supabase service-role key |
| `PUBLIC_URL` | for `set-webhook` | Public base URL of this deployment |
| `WEEX_API_KEY` / `WEEX_SECRET_KEY` / `WEEX_PASSPHRASE` | Weex checks only | Weex affiliate API credentials |
| `PORT` / `HOST` | no | Defaults `3000` / `0.0.0.0` |

Secrets are never logged: token values and `?t=…` query params are redacted before anything reaches
stdout.

## Setup

```bash
npm install
cp .env.example .env   # fill in your values
npm run dev            # local
npm run build          # tsc → dist/
npm start              # production
```

Deploy on Railway (New Project → Deploy from GitHub → add the env vars above). Railway gives you the
public URL to use as `PUBLIC_URL`.

### Point the bot at this service

```bash
BOT_TOKEN=... PUBLIC_URL=https://your-app.up.railway.app npm run set-webhook
```

That calls Telegram `setWebhook` with `${PUBLIC_URL}/webhook/telegram` and
`allowed_updates: ["message","edited_message","callback_query","chat_member"]`, then prints
`getWebhookInfo`. `chat_member` is what lets the service see channel joins and leaves, so it must be
in the list. The bot must be an administrator of the Founder Circle channel to receive them.

### Kommo webhooks to configure

Kommo → **Settings → Integrations → Webhooks**, pointing at this deployment:

| Event | URL |
|---|---|
| Lead status changed | `https://YOUR_URL/webhook/stage` |
| Contact added | `https://YOUR_URL/webhook/contact` |
| Contact updated | `https://YOUR_URL/webhook/contact` |
| Incoming message (optional, keyword tagging) | `https://YOUR_URL/webhook/message` |

### Salesbot call for the channel check

```json
{
  "handler": "widget_request",
  "params": {
    "url": "https://YOUR_URL/verify/channel",
    "data": { "lead_id": "{{lead.id}}" }
  }
}
```

Then branch on `{{json.status}}` = `joined`.

## Kommo fields used

**Lead** — `1067290` Telegram User ID, `1104292` Telegram Username, `1094948` Source Platform.

**Contact** (written by the Salesbot) — built-in name, `1003178` Phone (multitext WORK),
`1003180` Email (multitext WORK), `1383512` Country, `1383508` Age, `1383510` Interest.

**Pipeline 13228919 stages** — `102006055` Incoming leads, `102006151` In Converstation,
`111366003` Joined Channel, `102006155` Pending Registeration, `102006159` Pending Verification,
`102006163` Pending FTD, `102006167` Upsell, `102006171` Lost. Stage logic matches on **status id**,
never on the name.

**Tags** — `Link sent` (email accepted) sets `link_sent_at`; `Joined Channel` is set after the
membership check.

## Supabase `leads` columns

Keyed by `telegram_user_id`.

| Column | Written by |
|---|---|
| `kommo_lead_id` | telegram, stage, contact |
| `kommo_contact_id` | contact |
| `kommo_talk_id` | message — the Kommo talk, closed on the next `/start` |
| `telegram_user_id` | telegram (row key) |
| `telegram_username` | telegram |
| `source_platform` | telegram — updated on every `/start <code>` |
| `original_source_platform` | telegram — written once on first contact, never overwritten |
| `first_name`, `last_name` | telegram (Telegram profile) |
| `name` | contact (the name typed into the Salesbot) |
| `phone`, `email`, `country`, `age_bracket`, `interest` | contact |
| `current_tag` | telegram, contact, message |
| `kommo_stage` | telegram, stage |
| `started_at` | telegram, on insert |
| `link_sent_at` | contact, when the `Link sent` tag appears (once) |
| `joined_at` | stage / channel / `chat_member`, first join only |
| `left_at` | `chat_member`, on leave or kick |
| `lost_at` | stage, on Lost |
| `in_channel` | stage, channel, `chat_member` |
| `join_check_failures` | channel, incremented on every `not_joined` |

`kommo_talk_id` is newer than that migration — add it with:

```sql
alter table public.founder_circle_members add column if not exists kommo_talk_id text;
```

The table and these columns are created by `supabase_founder_circle.sql`. The service never creates
tables — it only reads and writes rows through the Supabase REST API.

## Notes

- `getChatMember` only works for users who have started the bot. In this funnel they always have.
- Lead lookup from a Telegram update first tries
  `GET /leads?filter[custom_fields][1067290]=<id>`; on first contact, when the field is not set yet,
  it falls back to matching the newest talks against the contact's Telegram chat `source_uid`
  (5 attempts, 2 s apart). The log line says which path was used.
