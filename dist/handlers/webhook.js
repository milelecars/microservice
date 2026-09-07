"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleNewMessage = handleNewMessage;
const env_1 = require("../env");
const kommo_1 = require("../kommo");
const supabase_1 = require("./supabase");
// ─── Keyword → Tag mapping (last match wins) ───────────────────────────────
const TAG_RULES = [
    {
        tag: 'Discovery',
        keywords: ['what is swiss vault', "what's swiss vault", 'swiss vault', 'who is fahad', 'how does it work', 'tell me more', 'what is this', 'what do you do'],
    },
    {
        tag: 'Beginner',
        keywords: ['what is trading', "what's trading", 'what is crypto', "what's crypto", 'how do i buy', 'never traded', "i'm new", "don't understand", 'what is a broker'],
    },
    {
        tag: 'Convince',
        // Removed overly broad: 'real', 'safe', 'trust' — too common in normal sentences
        keywords: ['is this a scam', 'is it legit', 'is this legit', 'is it real', 'is this real', 'is it fake', 'is this fake', 'guarantee', 'lose money', 'is it halal', 'is this halal', 'haram', 'show me proof', 'too good to be true', 'pyramid scheme', 'ponzi'],
    },
    {
        tag: 'Convert',
        // Removed overly broad: 'minimum', 'how much' — could be about anything
        keywords: ['sign up', 'how do i join', 'how to join', 'want to join', 'want to register', 'register now', 'how to register', 'how to deposit', 'make a deposit', 'payment method', 'how much to start', 'minimum deposit', 'send me the link', 'send me a link'],
    },
    {
        tag: 'Not Now',
        // Removed overly broad: 'maybe', 'busy' — too common
        keywords: ['not now', 'next month', 'wait for salary', 'think about it', 'not ready yet', 'come back later', 'remind me later', 'not interested yet'],
    },
    {
        tag: 'Member Care',
        keywords: ['lost my money', 'losing money', "don't understand the platform", 'stop loss hit', 'want to withdraw', 'how to withdraw', "can't find it", 'not working for me', 'having issues', 'need help'],
    },
];
function detectTag(text) {
    const lower = text.toLowerCase();
    let matched = null;
    for (const rule of TAG_RULES) {
        for (const keyword of rule.keywords) {
            if (lower.includes(keyword)) {
                matched = rule.tag;
                break;
            }
        }
    }
    return matched;
}
/**
 * Point the Supabase row at the Kommo lead/contact this message came from, and
 * backfill the lead's Telegram custom fields the first time we see the lead.
 */
async function linkLeadAndContact(lead, leadId, contactId, telegramUserId) {
    const row = await (0, supabase_1.getLead)(telegramUserId);
    if (row) {
        const changes = {};
        if (row.kommo_lead_id !== leadId)
            changes.kommo_lead_id = leadId;
        if (row.kommo_contact_id !== contactId)
            changes.kommo_contact_id = contactId;
        if (Object.keys(changes).length > 0) {
            await (0, supabase_1.updateLead)(telegramUserId, changes);
            console.log('[webhook] linked | lead:', leadId, '| contact:', contactId, '| TG user:', telegramUserId);
        }
    }
    else {
        console.warn('[webhook] no Supabase row for TG user:', telegramUserId, '- lead not linked');
    }
    // Once per lead: the Telegram fields are only written while 1067290 is empty
    if ((0, kommo_1.fieldValue)(lead?.custom_fields_values, kommo_1.LEAD_FIELD.TG_USER_ID))
        return row;
    const fields = [
        { field_id: kommo_1.LEAD_FIELD.TG_USER_ID, values: [{ value: Number(telegramUserId) }] },
    ];
    if (row?.telegram_username) {
        fields.push({ field_id: kommo_1.LEAD_FIELD.TG_USERNAME, values: [{ value: row.telegram_username }] });
    }
    if (row?.source_platform) {
        fields.push({ field_id: kommo_1.LEAD_FIELD.SOURCE_PLATFORM, values: [{ value: row.source_platform }] });
    }
    await (0, kommo_1.patch)(`/leads/${leadId}`, { custom_fields_values: fields });
    console.log('[webhook] lead fields set | lead:', leadId, '| TG user:', telegramUserId);
    return row;
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
                const contactId = msg.contact_id;
                const text = msg.text ?? '';
                console.log('[webhook] incoming message | lead:', leadId, '| contact:', contactId, '| text:', text);
                if (!leadId)
                    continue;
                try {
                    // Fetch once — used for the link step and for the tag replacement
                    const lead = await (0, kommo_1.get)(`/leads/${leadId}?with=tags`);
                    // ── Link the row to this lead/contact ─────────────────────────────
                    let telegramUserId;
                    if (contactId) {
                        telegramUserId = await (0, kommo_1.resolveTelegramUserId)(contactId);
                        if (telegramUserId) {
                            await linkLeadAndContact(lead, String(leadId), String(contactId), telegramUserId);
                        }
                        else {
                            console.warn('[webhook] could not resolve TG user ID from contact:', contactId);
                        }
                    }
                    else {
                        console.warn('[webhook] message has no contact_id - cannot link lead:', leadId);
                    }
                    // ── Keyword tagging ───────────────────────────────────────────────
                    if (!text)
                        continue;
                    const tag = detectTag(text);
                    if (!tag) {
                        console.log('[webhook] no keyword match');
                        continue;
                    }
                    console.log('[webhook] keyword matched → tag:', tag);
                    const currentTags = lead?._embedded?.tags ?? [];
                    console.log('[webhook] tags before replace:', currentTags.map(t => `${t.name}(${t.id})`).join(', ') || 'none');
                    // Delete ALL existing tags, add only the new keyword tag
                    const patchBody = {
                        tags_to_add: [{ name: tag }],
                    };
                    if (currentTags.length > 0) {
                        patchBody.tags_to_delete = currentTags.map(t => t.id);
                    }
                    await (0, kommo_1.patch)(`/leads/${leadId}`, patchBody);
                    console.log('[webhook] tag applied:', tag, '-> lead:', leadId);
                    // Sync tag to Supabase — resolved ID first, lead field as fallback
                    const tgUserId = telegramUserId ?? (0, kommo_1.fieldValue)(lead?.custom_fields_values, kommo_1.LEAD_FIELD.TG_USER_ID);
                    if (tgUserId) {
                        await (0, supabase_1.updateLead)(Number(tgUserId), { current_tag: tag });
                    }
                    else {
                        console.warn('[webhook] no TG user ID for lead:', leadId, '— skipping Supabase tag update');
                    }
                }
                catch (msgErr) {
                    console.error('[webhook] message handling failed:', (0, env_1.errText)(msgErr));
                }
            }
        }
        catch (err) {
            console.error('[webhook] error:', (0, env_1.errText)(err));
        }
    });
}
