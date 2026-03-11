import { Request, Response } from 'express';
import axios from 'axios';
import { updateLead } from './supabase';

const KOMMO_BASE  = 'https://fahadriazex1.kommo.com/api/v4';
const KOMMO_TOKEN = process.env.KOMMO_TOKEN!;

// ─── Keyword → Tag mapping (last match wins) ───────────────────────────────
const TAG_RULES: { tag: string; keywords: string[] }[] = [
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

function detectTag(text: string): string | null {
  const lower = text.toLowerCase();
  let matched: string | null = null;
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

export async function handleNewMessage(req: Request, res: Response): Promise<void> {
  res.status(200).json({ ok: true });

  setImmediate(async () => {
    try {
      const body = req.body;
      console.log('[webhook] incoming payload:', JSON.stringify(body));

      const messages = body?.message?.add ?? body?.message?.update ?? [];

      for (const msg of messages) {
        if (msg.type !== 'incoming') continue;

        const leadId = msg.entity_id ?? msg.element_id;
        const text   = msg.text ?? '';

        console.log('[webhook] incoming message | lead:', leadId, '| text:', text);

        if (!leadId || !text) continue;

        const tag = detectTag(text);
        if (!tag) {
          console.log('[webhook] no keyword match');
          continue;
        }

        console.log('[webhook] keyword matched → tag:', tag);

        try {
          // Fetch current tags to get IDs for deletion
          const leadResp = await axios.get(
            `${KOMMO_BASE}/leads/${leadId}?with=tags`,
            { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
          );
          const currentTags: { id: number; name: string }[] = leadResp.data?._embedded?.tags ?? [];
          console.log('[webhook] tags before replace:', currentTags.map(t => `${t.name}(${t.id})`).join(', ') || 'none');

          // Delete ALL existing tags, add only the new keyword tag
          const patchBody: any = { tags_to_add: [{ name: tag }] };
          if (currentTags.length > 0) {
            patchBody.tags_to_delete = currentTags.map(t => t.id);
          }
          console.log('[webhook] patch payload:', JSON.stringify(patchBody));

          const patchResp = await axios.patch(
            `${KOMMO_BASE}/leads/${leadId}`,
            patchBody,
            { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
          );
          console.log('[webhook] ✓ tag applied:', tag, '→ lead:', leadId, '| status:', patchResp.status);

          // Sync tag to Supabase — look up TG user ID from the lead
          const tgUserId = leadResp.data?.custom_fields_values
            ?.find((f: any) => f.field_id === 1067290)?.values?.[0]?.value;
          if (tgUserId) {
            await updateLead(Number(tgUserId), { current_tag: tag });
          } else {
            console.warn('[webhook] no TG user ID on lead — skipping Supabase tag update');
          }

        } catch (patchErr: any) {
          console.error('[webhook] tag failed:', JSON.stringify(patchErr?.response?.data));
        }
      }
    } catch (err: any) {
      console.error('[webhook] error:', err?.response?.data ?? err.message);
    }
  });
}