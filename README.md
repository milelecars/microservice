# kommo-verify

Glue service between **@FounderCircleAdminBot** (Telegram), **Kommo** (subdomain `fahadriazex1`,
Founder Circle pipeline `13228919`) and **Supabase**.

It relays Telegram updates into Kommo's Salesbot, stamps the lead with the Telegram identity and
traffic source, checks Founder Circle channel membership, and mirrors everything Kommo knows about
a lead into the Supabase `leads` table.

**Greeting-only.** The bot asks nothing — no name, country, age, interest, phone or email. It
greets, sends the join card, verifies the join and welcomes.

It also still serves the two Weex checks used by the older funnel (`/verify/registered`,
`/verify/deposited`) — those are untouched.

## Flow

1. User opens `t.me/FounderCircleAdminBot?start=instagram`.
2. Telegram POSTs the update to `POST /webhook/telegram`.
3. The service forwards it to Kommo's Telegram hook (`KOMMO_TG_WEBHOOK`), rewriting `/start …` to
   `Hi` so the Salesbot starts cleanly.
4. It resolves the Kommo lead, patches `Telegram User ID`, `Telegram Username` and
   `Source Platform` onto it, and inserts/updates the Supabase row.
5. On the same `/start`, and without waiting for anything, the service stamps `link_sent_at`,
   `join_message_sent` and the `Link sent` tag, then sends the join card from the bot — a
   *Join Founder Circle* link button and an *I've Joined* button.
6. Kommo's "contact added/updated" webhook hits `POST /webhook/contact`, which keeps the name, the
   tags and the Kommo ids in Supabase, and writes `link sent` into contact field `1003176` once
   Kommo has a contact to write it to.
7. Tapping *I've Joined* hits `POST /webhook/telegram` as a `callback_query`: the service calls
   `getChatMember` and either runs the welcome routine or asks the person to join first and try
   again. A `chat_member` update from the channel runs the same welcome routine, whichever
   arrives first.
8. The welcome routine sends the welcome message, writes `joined_at` / `in_channel` /
   `welcome_sent`, moves the Kommo lead to **Joined Channel**, swaps the tag, sets the contact
   status to `joined` and closes the talk. `POST /webhook/stage` still records stage changes made
   inside Kommo, and `chat_member` keeps `in_channel` honest when someone leaves later.

## Endpoints

| Endpoint | Called by | What it does |
|---|---|---|
| `POST /webhook/telegram` | Telegram | Forwards updates to Kommo, upserts Supabase, sends the join card on `/start` and brings it back for anyone still outside, handles the *I've Joined* and *Continue* taps and `chat_member` join/leave |
| `POST /webhook/contact` | Kommo (contact added / updated) | Syncs the contact's name, tags and status field into Supabase |
| `POST /webhook/stage` | Kommo (lead status changed) | Syncs `kommo_stage`, sets `joined_at` / `lost_at` |
| `POST /webhook/message` | Kommo (incoming message) | Keyword → tag rules on the lead |
| `POST /verify/channel` | Kommo Salesbot (`widget_request`) | Telegram channel membership via `getChatMember`. Still works, but no longer on the main path |
| `POST /verify/registered` | Kommo Salesbot | Weex UID exists under the affiliate account |
| `POST /verify/deposited` | Kommo Salesbot | Weex UID has deposited |
| `POST /admin/resend-join` | You, by hand | One-time catch-up: resends the join card to everyone still outside. Needs `X-Admin-Key` |
| `GET /dashboard` | You, in a browser | The funnel dashboard. Basic auth |
| `GET /dashboard/data` | The dashboard page | Every `founder_circle_members` row as JSON, minus the private columns |
| `GET /debug/pending` | You, by hand | What the pending-match table is holding right now |
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
| `CHANNEL_INVITE_LINK` | no | Invite link on the Join button (defaults to the Founder Circle link) |
| `SUPABASE_URL` | yes | `https://<project>.supabase.co` |
| `SUPABASE_KEY` | yes | Supabase service-role key |
| `PUBLIC_URL` | for `set-webhook` | Public base URL of this deployment |
| `ADMIN_KEY` | for `/admin/*` | Shared secret for `X-Admin-Key`. Without it the admin route answers 503 |
| `DASHBOARD_PASSWORD` | for `/dashboard` | Basic-auth password, username `founder`. Without it the dashboard answers 503 |
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

**Contact** — `1003176` Status, the only contact field this service writes: `link sent` when the
card goes out, `joined` after the membership check. `1003178` Phone, `1003180` Email, `1383512`
Country, `1383508` Age and `1383510` Interest are left over from the question era and are no longer
read or written.

**Pipeline 13228919 stages** — `102006055` Incoming leads, `102006151` In Converstation,
`111366003` Joined Channel, `102006155` Pending Registeration, `102006159` Pending Verification,
`102006163` Pending FTD, `102006167` Upsell, `102006171` Lost. Stage logic matches on **status id**,
never on the name.

**Tags** — `Link sent` goes on with the join card, at greeting time; `Joined Channel` is set after the
membership check. The reminder loop adds `Reminder 1 sent` … `Reminder 4 sent` as each nudge goes
out, `Bot blocked` instead when Telegram answers 403, and `Resumed after reminder` the first time a
nudged person comes back. All of these are appended — existing tags are never removed.

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
| `name` | contact (the Kommo contact name) |
| `phone`, `email`, `country`, `age_bracket`, `interest` | nobody — question-era columns, kept as they are on old rows and left null on new ones |
| `current_tag` | telegram, contact, message |
| `kommo_stage` | telegram, stage |
| `started_at` | telegram, on insert |
| `link_sent_at` | telegram, on the `/start` that sends the join card (once) |
| `joined_at` | stage / channel / `chat_member`, first join only |
| `left_at` | `chat_member`, on leave or kick |
| `lost_at` | stage, on Lost |
| `in_channel` | stage, channel, `chat_member` |
| `join_check_failures` | channel and the "I've Joined" tap, incremented on every failed check |
| `join_message_sent` | telegram — the join card went out once |
| `join_message_sent_at` | join step — last join message; automatic sends are throttled to one a minute, the *I've Joined* retry always sends |
| `welcome_sent` | welcome routine — the welcome went out once |
| `last_activity_at` | telegram — every message or button tap from the person |
| `reminder_stage` | reminders — 0-4, how many nudges have gone out |
| `reminder_sent_at` | reminders — when the last nudge went out |

These three are newer than that migration — add them with:

```sql
alter table public.founder_circle_members
  add column if not exists kommo_talk_id text,
  add column if not exists join_message_sent boolean not null default false,
  add column if not exists join_message_sent_at timestamptz,
  add column if not exists welcome_sent boolean not null default false,
  add column if not exists last_activity_at timestamptz,
  add column if not exists reminder_stage integer not null default 0,
  add column if not exists reminder_sent_at timestamptz;

update public.founder_circle_members
  set last_activity_at = coalesce(updated_at, started_at)
  where last_activity_at is null;
```

## Reminders

A loop started with the server checks every 5 minutes for rows that have `link_sent_at` but no
`joined_at`, and nudges them with a **Continue ▶️** button. Since the card goes out with the
greeting, that is everyone who pressed Start and has not joined. The ladder is 2 h → 8 h → 24 h → 72 h, measured from the last sign of life
(`last_activity_at`, or `reminder_sent_at` once we have nudged), so any reply resets the clock and
four reminders is the maximum. Nothing is sent between 23:00 and 08:00 in the person's own time —
guessed from their phone's dialling code, falling back to Asia/Dubai — the row is simply picked up
on a later run. Someone who has blocked the bot is moved straight to stage 4.

Tapping **Continue** simply sends the join card again. `/start` does the same for anyone who somehow
has no `link_sent_at` yet.

### One-time catch-up

```bash
curl -X POST https://YOUR_URL/admin/resend-join   -H "X-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' -d '{}'
```

Resends the join card to everyone with `link_sent_at` set who is not in the channel, one per second,
and answers with the count. Pass `{"telegram_user_id": 123}` to target one person.

The table and these columns are created by `supabase_founder_circle.sql`. The service never creates
tables — it only reads and writes rows through the Supabase REST API.

## Dashboard

`https://<railway-url>/dashboard` — sign in with username `founder` and the password in
`DASHBOARD_PASSWORD`; if that variable is not set the page answers `503 Dashboard password not set`.

It shows the funnel end to end: how many people started, have the link and joined, the daily
started/joined curve, join rate per source, age/interest/country of the members (from the rows that
still hold answers), and a searchable, filterable, CSV-exportable table of everyone in
`founder_circle_members`. The **Where people stop** card says it is not used in greeting-only mode
whenever no row is left mid-flow, which is the normal state now.

The page is `public/dashboard.html` and holds no Supabase credentials. It calls
`GET /dashboard/data`, which reads the table server-side with `SUPABASE_KEY`, drops the private
columns (`broker_uid`, `ftd_amount`, `ftd_date`, `contact_number`, `kommo_talk_id`, `invite_link`)
and caches the result for 60 seconds — **Refresh** re-reads through the cache, `?fresh=1` bypasses
it. The paste-an-export box is still there as a fallback.

## Notes

- `getChatMember` only works for users who have started the bot. In this funnel they always have.
- Lead lookup from a Telegram update first tries
  `GET /leads?filter[custom_fields][1067290]=<id>`; on first contact, when the field is not set yet,
  it falls back to matching the newest talks against the contact's Telegram chat `source_uid`
  (5 attempts, 2 s apart). The log line says which path was used.
