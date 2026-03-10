"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyChannel = verifyChannel;
const axios_1 = __importDefault(require("axios"));
const callback_1 = require("./callback");
async function verifyChannel(req, res) {
    const { return_url, data, token } = req.body;
    const telegramUserId = data?.telegram_user_id;
    console.log('[channel] received', { telegramUserId, return_url });
    res.status(200).json({ ok: true });
    setImmediate(async () => {
        if (!return_url) {
            console.error('[channel] missing return_url');
            return;
        }
        if (!telegramUserId) {
            await (0, callback_1.resumeBot)(return_url, 'not_joined', token, 'Missing Telegram user ID');
            return;
        }
        const botToken = process.env.BOT_TOKEN;
        const channelId = process.env.CHANNEL_ID;
        if (!botToken || !channelId) {
            console.error('[channel] missing BOT_TOKEN or CHANNEL_ID env vars');
            await (0, callback_1.resumeBot)(return_url, 'not_joined', token, 'Server config error');
            return;
        }
        try {
            const response = await axios_1.default.get(`https://api.telegram.org/bot${botToken}/getChatMember`, {
                params: { chat_id: channelId, user_id: telegramUserId },
                timeout: 10000,
            });
            const status = response.data?.result?.status;
            console.log('[channel] getChatMember status:', status, 'for user:', telegramUserId);
            const isJoined = ['member', 'administrator', 'creator'].includes(status);
            await (0, callback_1.resumeBot)(return_url, isJoined ? 'joined' : 'not_joined', token, isJoined ? 'Channel membership confirmed' : 'User has not joined the channel');
        }
        catch (err) {
            const tgError = err?.response?.data?.description ?? '';
            console.error('[channel] Telegram API error:', tgError);
            await (0, callback_1.resumeBot)(return_url, 'not_joined', token, tgError || 'Telegram API error');
        }
    });
}
