import { Request, Response } from 'express';
import axios from 'axios';

const KOMMO_BASE = 'https://fahadriazex1.kommo.com/api/v4';

export async function handleNewMessage(req: Request, res: Response): Promise<void> {
  res.status(200).json({ ok: true }); // ACK immediately

  setImmediate(async () => {
    try {
      const body = req.body;
      console.log('[webhook] incoming payload:', JSON.stringify(body));

      // Kommo sends message webhooks with this structure:
      // body.message.add[0] or body.message.update[0]
      const messages = body?.message?.add ?? body?.message?.update ?? [];

      for (const msg of messages) {
        // Only process incoming messages from contacts (not outgoing from agents)
        if (msg.type !== 'incoming') continue;

        const chatId = msg.chat_id;         // Kommo internal chat UUID
        const telegramUserId = msg.author_id; // This is the Telegram user ID
        const contactId = msg.contact_id;

        console.log('[webhook] message event:', { chatId, telegramUserId, contactId });

        if (!telegramUserId || !contactId) continue;

        // Save to Kommo contact field 1067290
        const kommoToken = process.env.KOMMO_TOKEN!;
        await axios.patch(`${KOMMO_BASE}/contacts/${contactId}`, {
          custom_fields_values: [
            { field_id: 1067290, values: [{ value: String(telegramUserId) }] }
          ]
        }, {
          headers: { Authorization: `Bearer ${kommoToken}` },
          timeout: 10_000,
        });

        console.log('[webhook] saved Telegram user ID', telegramUserId, 'to contact', contactId);
      }
    } catch (err: any) {
      console.error('[webhook] error:', err?.response?.data ?? err.message);
    }
  });
}