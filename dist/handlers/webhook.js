"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleNewMessage = handleNewMessage;
const env_1 = require("../env");
const kommo_1 = require("../kommo");
const pending_1 = require("../pending");
const contact_1 = require("./contact");
const supabase_1 = require("./supabase");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
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
 * Last resort for the first message of a brand new lead, whose text Kommo may
 * render differently from what we forwarded: if nothing in Supabase points at
 * this lead yet, take the newest queued user who has no lead of their own.
 */
async function matchByRecency(leadId) {
    const alreadyLinked = await (0, supabase_1.getLeadByKommoLeadId)(leadId);
    if (alreadyLinked)
        return null;
    for (const candidate of (0, pending_1.recentPending)(pending_1.FALLBACK_WINDOW_MS)) {
        const row = await (0, supabase_1.getLead)(candidate.telegram_user_id);
        if (row && !row.kommo_lead_id)
            return candidate;
    }
    return null;
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
        if (Object.keys(changes).length > 0)
            await (0, supabase_1.updateLead)(telegramUserId, changes);
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
                const talkId = msg.talk_id;
                const text = msg.text ?? '';
                const authorName = msg.author?.name ?? '';
                console.log('[webhook] incoming message | lead:', leadId, '| contact:', contactId, '| text:', text);
                if (!leadId)
                    continue;
                try {
                    // Fetch once — used for the link step and for the tag replacement
                    const lead = await (0, kommo_1.get)(`/leads/${leadId}?with=tags`);
                    // ── Match this message back to the Telegram update we forwarded ───
                    let telegramUserId;
                    if (contactId) {
                        let match = (0, pending_1.matchPendingByText)(text, authorName);
                        let via = 'message match';
                        // First Kommo message of a lead: the text Kommo shows can differ
                        // from what we forwarded, so fall back to the newest queued user
                        // who is not linked to a lead yet.
                        if (!match) {
                            match = await matchByRecency(leadId);
                            if (match)
                                via = 'fallback by recency';
                        }
                        if (match) {
                            telegramUserId = String(match.telegram_user_id);
                            (0, pending_1.takePending)(match);
                            await linkLeadAndContact(lead, String(leadId), String(contactId), telegramUserId);
                            console.log('[link] lead', leadId, '<->', 'TG', telegramUserId, 'via', via);
                            // Backfill whatever Kommo already holds for this contact
                            await (0, contact_1.syncContactAnswers)(contactId, leadId, telegramUserId);
                        }
                        else {
                            console.warn('[link] unmatched message | text:', text, '| author:', authorName || '-', '| pending:', JSON.stringify((0, pending_1.listPending)()));
                        }
                    }
                    else {
                        console.warn('[webhook] message has no contact_id - cannot link lead:', leadId);
                    }
                    // ── Sync the Salesbot answers ─────────────────────────────────────
                    // Kommo writes the contact field just after the message arrives, so
                    // give it a moment before reading the contact back.
                    if (contactId) {
                        const answersFor = telegramUserId ?? (0, kommo_1.fieldValue)(lead?.custom_fields_values, kommo_1.LEAD_FIELD.TG_USER_ID);
                        if (answersFor) {
                            // Remember the talk so a later /start can close it
                            if (talkId) {
                                const row = await (0, supabase_1.getLead)(answersFor);
                                if (row && row.kommo_talk_id !== String(talkId)) {
                                    await (0, supabase_1.updateLead)(answersFor, { kommo_talk_id: String(talkId) });
                                }
                            }
                            await sleep(3000);
                            await (0, contact_1.syncContactAnswers)(contactId, leadId, answersFor);
                        }
                        else {
                            console.warn('[answers] no TG user ID for lead:', leadId, '- skipping answer sync');
                        }
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
