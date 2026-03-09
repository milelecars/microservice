import { Request, Response } from 'express';
import axios from 'axios';
import { resumeBot } from '../callback';

/**
 * POST /verify/channel
 *
 * Checks if a Telegram user has joined the required channel.
 * Uses Telegram Bot API: getChatMember
 *
 * Kommo sends:
 *   { token, return_url, data: { telegram_user_id, lead_id } }
 */
export async function verifyChannel(req: Request, res: Response): Promise<void> {
  const { return_url, data } = req.body;
  const telegramUserId = data?.telegram_user_id;

  console.log('[channel] received', { telegramUserId, return_url });

  // Acknowledge immediately — Kommo requires response within 2 seconds
  res.status(200).json({ ok: true });

  // Async verification
  setImmediate(async () => {
    if (!return_url) {
      console.error('[channel] missing return_url');
      return;
    }

    if (!telegramUserId) {
      await resumeBot(return_url, 'not_joined', 'Missing Telegram user ID');
      return;
    }

    const botToken = process.env.BOT_TOKEN;
    const channelId = process.env.CHANNEL_ID; // e.g. @yourchannel or -100123456789

    if (!botToken || !channelId) {
      console.error('[channel] missing BOT_TOKEN or CHANNEL_ID env vars');
      await resumeBot(return_url, 'not_joined', 'Server config error');
      return;
    }

    try {
      const response = await axios.get(
        `https://api.telegram.org/bot${botToken}/getChatMember`,
        {
          params: { chat_id: channelId, user_id: telegramUserId },
          timeout: 10_000,
        }
      );

      const status = response.data?.result?.status;
      console.log('[channel] getChatMember status:', status, 'for user:', telegramUserId);

      // Telegram statuses: member, administrator, creator = joined
      // left, kicked, restricted = not joined
      const isJoined = ['member', 'administrator', 'creator'].includes(status);

      await resumeBot(
        return_url,
        isJoined ? 'joined' : 'not_joined',
        isJoined ? 'Channel membership confirmed' : 'User has not joined the channel'
      );

    } catch (err: any) {
      // Telegram returns 400 if user never started the bot (can't check membership)
      const tgError = err?.response?.data?.description ?? '';
      console.error('[channel] Telegram API error:', tgError);

      // If Telegram says "user not found" or "chat not found", treat as not joined
      await resumeBot(return_url, 'not_joined', tgError || 'Telegram API error');
    }
  });
}
