# kommo-verify

Slim verification microservice for Kommo SalesBot.
Handles 3 checks triggered by Kommo's `widget_request` handler.

## Endpoints

| Endpoint | What it checks |
|---|---|
| `POST /verify/channel` | Telegram channel membership via getChatMember |
| `POST /verify/registered` | Weex UID exists under affiliate account |
| `POST /verify/deposited` | Weex UID has made at least one deposit |

## How it works

1. Kommo SalesBot fires `widget_request` → POSTs to one of the endpoints
2. This service responds HTTP 200 immediately (Kommo requires < 2 seconds)
3. Async: calls the relevant API (Telegram or Weex)
4. Calls back Kommo's `return_url` with `{ data: { status: "..." } }`
5. Kommo reads `{{json.status}}` in the next SalesBot condition block

## Status values returned

| Endpoint | Status values |
|---|---|
| `/verify/channel` | `joined` / `not_joined` / `error` |
| `/verify/registered` | `verified` / `not_found` / `error` |
| `/verify/deposited` | `deposited` / `no_deposit` / `error` |

## Setup

### 1. Clone and install
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in your values
```

### 3. Run locally
```bash
npm run dev
```

### 4. Deploy to Railway (recommended — free tier available)

1. Go to https://railway.app → New Project → Deploy from GitHub
2. Connect this repo
3. Add environment variables in Railway dashboard (copy from .env.example)
4. Railway gives you a public URL like `https://kommo-verify-production.up.railway.app`
5. Use that URL in your Kommo SalesBot JSON

## Kommo SalesBot usage

In your SalesBot JSON, use `widget_request` like this:

```json
{
  "handler": "widget_request",
  "params": {
    "url": "https://YOUR_RAILWAY_URL/verify/channel",
    "data": {
      "telegram_user_id": "{{contact.id}}",
      "lead_id": "{{lead.id}}"
    }
  }
}
```

Then read the result in the next step:
```json
{
  "handler": "conditions",
  "params": {
    "logic": "and",
    "conditions": [
      { "term1": "{{json.status}}", "term2": "joined", "operation": "=" }
    ],
    "result": [
      { "handler": "goto", "params": { "type": "question", "step": 2 } }
    ]
  }
}
```

## Getting your Channel ID

Forward any message from your Telegram channel to @userinfobot — it will reply with the channel's numeric ID (e.g. `-1001234567890`). Use that as `CHANNEL_ID`.

## Important note on channel check

Telegram's `getChatMember` only works if the user has previously started your bot.
If a user joins the channel without ever messaging the bot first, Telegram will return an error.
In practice this is fine — users arrive via your bot, so they will have started it.
