import express from 'express';
import { verifyChannel } from './handlers/channel';
import { verifyRegistered } from './handlers/registered';
import { verifyDeposited } from './handlers/deposited';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => { console.log('[raw body]', JSON.stringify(req.body)); next(); });

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Verification endpoints ────────────────────────────────────────────────────
// All three follow the same contract:
//
//   REQUEST  (from Kommo widget_request):
//     POST /verify/channel    { token, return_url, data: { telegram_user_id, lead_id } }
//     POST /verify/registered { token, return_url, data: { trader_id, lead_id } }
//     POST /verify/deposited  { token, return_url, data: { trader_id, lead_id } }
//
//   RESPONSE (immediate, within 2 seconds):
//     HTTP 200  — acknowledges receipt, Kommo holds the bot
//
//   CALLBACK  (async, to return_url):
//     { data: { status: "joined" | "not_joined" | "verified" | "not_found" | "deposited" | "no_deposit" } }
//
app.post('/verify/channel',    verifyChannel);
app.post('/verify/registered', verifyRegistered);
app.post('/verify/deposited',  verifyDeposited);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`kommo-verify running on port ${PORT}`));
