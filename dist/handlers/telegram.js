"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleNewMessage = handleNewMessage;
const axios_1 = __importDefault(require("axios"));
const KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';
const KOMMO_TOKEN = process.env.KOMMO_TOKEN;
// ─── Keyword → Tag mapping ─────────────────────────────────────────────────
// Order matters: LAST match wins (per your priority rule)
const TAG_RULES = [
    {
        tag: 'Discovery',
        keywords: ['what is swiss vault', 'who is fahad', 'how does it work', 'tell me more', 'what is this', 'what do you do'],
    },
    {
        tag: 'Beginner',
        keywords: ['what is trading', 'what is crypto', 'how do i buy', 'never traded', "i'm new", 'don\'t understand', 'what is a broker'],
    },
    {
        tag: 'Convince',
        keywords: ['scam', 'trust', 'legit', 'real', 'fake', 'guarantee', 'lose money', 'safe', 'halal', 'haram', 'proof', 'too good', 'pyramid'],
    },
    {
        tag: 'Convert',
        keywords: ['sign up', 'how do i join', 'link', 'register', 'deposit', 'payment', 'minimum', 'how much', 'send me'],
    },
    {
        tag: 'Not Now',
        keywords: ['later', 'not now', 'next month', 'salary', 'busy', 'think about it', 'not ready', 'come back', 'maybe'],
    },
    {
        tag: 'Member Care',
        keywords: ['lost money', "don't understand", 'stop loss', 'withdraw', "can't find", 'not working'],
    },
    // Note: 'Upsell' is applied manually when agent moves lead to Stage 5 — not keyword based
];
function detectTag(text) {
    const lower = text.toLowerCase();
    let matched = null;
    // Scan all rules — last match wins (priority rule)
    for (const rule of TAG_RULES) {
        for (const keyword of rule.keywords) {
            if (lower.includes(keyword)) {
                matched = rule.tag;
                break; // move to next rule, don't need to check more keywords in this rule
            }
        }
    }
    return matched;
}
async function applyTagToLead(leadId, newTag) {
    // Fetch existing lead tags first so we don't overwrite them
    const leadResp = await axios_1.default.get(`${KOMMO_BASE}/leads/${leadId}`, { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10000 });
    const existingTags = leadResp.data?.tags ?? [];
    const autoTagNames = TAG_RULES.map(r => r.tag);
    // Remove any previous auto-tags, keep manual ones, add the new tag
    const filteredTags = existingTags.filter(t => !autoTagNames.includes(t.name));
    const updatedTags = [...filteredTags, { name: newTag }];
    await axios_1.default.patch(`${KOMMO_BASE}/leads/${leadId}`, { tags: updatedTags }, { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10000 });
    console.log('[webhook] tag applied:', newTag, '→ lead:', leadId);
}
async function handleNewMessage(req, res) {
    res.status(200).json({ ok: true });
    setImmediate(async () => {
        try {
            const body = req.body;
            console.log('[webhook] incoming payload:', JSON.stringify(body));
            const messages = body?.message?.add ?? body?.message?.update ?? [];
            for (const msg of messages) {
                if (msg.type !== 'incoming')
                    continue;
                const leadId = msg.entity_id ?? msg.element_id;
                const text = msg.text ?? '';
                console.log('[webhook] incoming message | lead:', leadId, '| text:', text);
                if (!leadId || !text)
                    continue;
                // Detect keyword tag
                const tag = detectTag(text);
                if (!tag) {
                    console.log('[webhook] no keyword match for:', text);
                    continue;
                }
                console.log('[webhook] keyword matched → tag:', tag);
                try {
                    await applyTagToLead(leadId, tag);
                }
                catch (err) {
                    console.error('[webhook] tag apply failed:', err?.response?.data ?? err.message);
                }
            }
        }
        catch (err) {
            console.error('[webhook] error:', err?.response?.data ?? err.message);
        }
    });
}
