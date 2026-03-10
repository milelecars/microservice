"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resumeBot = resumeBot;
const axios_1 = __importDefault(require("axios"));
async function resumeBot(returnUrl, status, kommoToken, message) {
    try {
        await axios_1.default.post(returnUrl, {
            data: { status, message: message ?? '' },
        }, {
            timeout: 10000,
            headers: {
                Authorization: `Bearer ${kommoToken}`,
            },
        });
        console.log(`[callback] ${status} → ${returnUrl}`);
    }
    catch (err) {
        console.error('[callback] failed to resume bot', {
            returnUrl,
            status,
            httpStatus: err?.response?.status,
            response: err?.response?.data,
        });
    }
}
