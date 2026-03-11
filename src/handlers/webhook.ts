import { Request, Response } from 'express';
import axios from 'axios';

const KOMMO_BASE  = 'https://fahadriazex1.kommo.com/api/v4';
const KOMMO_TOKEN = process.env.KOMMO_TOKEN!;

// ─── Keyword → Tag mapping (last match wins) ───────────────────────────────
const TAG_RULES: { tag: string; keywords: string[] }[] = [
  {
    tag: 'Discovery',
    keywords: ['what is swiss vault', 'who is fahad', 'how does it work', 'tell me more', 'what is this', 'what do you do'],
  },
  {
    tag: 'Beginner',
    keywords: ['what is trading', 'what is crypto', 'how do i buy', 'never traded', "i'm new", "don't understand", 'what is a broker'],
  },
  {
    tag: 'Convince',
    keywords: ['scam', 'trust', 'legit', 'real', 'fake', 'guarantee', 'lose money', 'safe', 'halal', 'haram', 'proof', 'too good', 'pyramid'],
  },
  {
    tag: 'Convert',
    keywords: ['sign up', 'how do i join', 'register', 'deposit', 'payment', 'minimum', 'how much', 'send me'],
  },
  {
    tag: 'Not Now',
    keywords: ['later', 'not now', 'next month', 'salary', 'busy', 'think about it', 'not ready', 'come back', 'maybe'],
  },
  {
    tag: 'Member Care',
    keywords: ['lost money', "don't understand", 'stop loss', 'withdraw', "can't find", 'not working'],
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
          // Step 1: fetch current tags so we can log them
          const leadResp = await axios.get(
            `${KOMMO_BASE}/leads/${leadId}`,
            { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
          );
          const currentTags = leadResp.data?.tags ?? [];
          console.log('[webhook] current tags before clear:', JSON.stringify(currentTags));

          // Step 2: clear all existing tags
          const clearResp = await axios.patch(
            `${KOMMO_BASE}/leads/${leadId}`,
            { tags: [] },
            { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
          );
          console.log('[webhook] clear tags response status:', clearResp.status, '| tags after clear:', JSON.stringify(clearResp.data?.tags));

          // Step 3: set the new tag
          const setResp = await axios.patch(
            `${KOMMO_BASE}/leads/${leadId}`,
            { tags: [{ name: tag }] },
            { headers: { Authorization: `Bearer ${KOMMO_TOKEN}` }, timeout: 10_000 }
          );
          console.log('[webhook] set tag response status:', setResp.status, '| tags after set:', JSON.stringify(setResp.data?.tags));
          console.log('[webhook] ✓ tag applied:', tag, '→ lead:', leadId);
        } catch (patchErr: any) {
          console.error('[webhook] tag failed:', JSON.stringify(patchErr?.response?.data));
        }
      }
    } catch (err: any) {
      console.error('[webhook] error:', err?.response?.data ?? err.message);
    }
  });
}