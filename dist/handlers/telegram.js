"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleTelegramWebhook = handleTelegramWebhook;
const axios_1 = __importDefault(require("axios"));
const supabase_1 = require("./supabase");
const KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
// Lead custom fields
const FIELD_TG_USER_ID = 1067290; // numeric
const FIELD_TG_USERNAME = 1104292; // text — Telegram @username
const FIELD_SOURCE_PLATFORM = 1094948; // text — TikTok / Instagram / etc
// Kommo's internal Telegram webhook URL
const KOMMO_TG_WEBHOOK = 'https://amojo.amocrm.com/~external/hooks/telegram?t=8593034950:AAG7lU1tK8XJWTIbVSHyeFHFwggzDiJD8Rk&';
// Map start parameter → display name
const SOURCE_MAP = {
    tiktok: 'TikTok',
    instagram: 'Instagram',
    youtube: 'YouTube',
    facebook: 'Facebook',
    direct: 'Direct',
};
async function handleTelegramWebhook(req, res) {
    res.status(200).json({ ok: true });
    setImmediate(async () => {
        try {
            const body = req.body;
            console.log('[telegram] incoming update:', JSON.stringify(body));
            // 1. Extract sender info
            const msg = body?.message ?? body?.edited_message;
            const from = msg?.from ?? body?.callback_query?.from;
            const telegramUserId = from?.id;
            const telegramUsername = from?.username;
            const firstName = from?.first_name;
            const lastName = from?.last_name;
            const chatId = msg?.chat?.id ?? from?.id;
            if (!telegramUserId || !chatId) {
                console.warn('[telegram] no from.id in update — skipping');
                return;
            }
            console.log('[telegram] user:', { id: telegramUserId, username: telegramUsername });
            // 2. Parse source platform from /start <param>
            const msgText = msg?.text ?? '';
            const isStartCommand = msgText === '/start' || msgText.startsWith('/start ');
            let sourcePlatform;
            if (msgText.startsWith('/start ')) {
                const param = msgText.replace('/start ', 'Hi').trim().toLowerCase();
                sourcePlatform = SOURCE_MAP[param] ?? param;
                console.log('[telegram] source platform:', sourcePlatform);
            }
            // 3. Forward to Kommo — strip /start command so it creates the lead + fires Salesbot
            const forwardBody = isStartCommand
                ? { ...body, message: { ...msg, text: 'Hi', entities: undefined } }
                : body;
            axios_1.default.post(KOMMO_TG_WEBHOOK, forwardBody, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000,
            })
                .then(() => console.log('[telegram] forwarded to Kommo ✓'))
                .catch(err => console.error('[telegram] forward failed:', err.message));
            // 4. Wait for Kommo to create the talk/lead
            await new Promise(r => setTimeout(r, 3000));
            // 5. Find the most recent telegram talk → get lead ID
            const talksResp = await axios_1.default.get(`${KOMMO_BASE}/talks?limit=5`, { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10000 });
            const talks = talksResp.data?._embedded?.talks ?? [];
            const activeTalk = talks
                .filter(t => t.origin === 'telegram' && t.entity_id && t.entity_type === 'lead')
                .sort((a, b) => b.created_at - a.created_at)[0];
            if (!activeTalk) {
                console.warn('[telegram] no active telegram talk found');
                return;
            }
            const leadId = String(activeTalk.entity_id);
            console.log('[telegram] matched lead:', leadId);
            // 6. Patch Kommo lead fields
            const leadFields = [
                { field_id: FIELD_TG_USER_ID, values: [{ value: Number(telegramUserId) }] },
            ];
            if (telegramUsername) {
                leadFields.push({ field_id: FIELD_TG_USERNAME, values: [{ value: `@${telegramUsername}` }] });
            }
            if (sourcePlatform) {
                leadFields.push({ field_id: FIELD_SOURCE_PLATFORM, values: [{ value: sourcePlatform }] });
            }
            const leadPatch = await axios_1.default.patch(`${KOMMO_BASE}/leads/${leadId}`, { custom_fields_values: leadFields }, { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10000 });
            console.log('[telegram] lead patched | status:', leadPatch.status);
            // 7. Upsert into Supabase
            await (0, supabase_1.upsertLead)({
                kommo_lead_id: leadId,
                telegram_user_id: Number(telegramUserId),
                telegram_username: telegramUsername ? `@${telegramUsername}` : undefined,
                source_platform: sourcePlatform,
                first_name: firstName,
                last_name: lastName,
            });
            console.log('[telegram] ✓ done | lead:', leadId, '| TG ID:', telegramUserId, '| username:', telegramUsername ?? 'none', '| source:', sourcePlatform ?? 'unknown');
        }
        catch (err) {
            console.error('[telegram] error:', err?.response?.data ?? err.message);
        }
    });
}
