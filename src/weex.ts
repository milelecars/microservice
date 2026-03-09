import crypto from 'crypto';
import axios from 'axios';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WeexTrader {
  uid: string;
  registerTime: string;
  kycResult: boolean;
  inviteCode: string;
  firstDeposit?: string;
  lastDeposit?: string;
  firstTrade?: string;
  lastTrade?: string;
}

// ── Signature ─────────────────────────────────────────────────────────────────

function sign(secretKey: string, timestamp: string, queryString: string): string {
  const requestPath = '/api/v2/rebate/affiliate/getAffiliateUIDs';
  const message = `${timestamp}GET${requestPath}?${queryString}`;
  return crypto.createHmac('sha256', secretKey).update(message, 'utf8').digest('base64');
}

// ── Lookup ────────────────────────────────────────────────────────────────────

export async function getTraderByUid(uid: string): Promise<WeexTrader | null> {
  const { WEEX_API_KEY, WEEX_SECRET_KEY, WEEX_PASSPHRASE } = process.env;

  if (!WEEX_API_KEY || !WEEX_SECRET_KEY || !WEEX_PASSPHRASE) {
    throw new Error('Missing Weex env vars');
  }

  const timestamp = String(Date.now());
  const qp = new URLSearchParams({ uid, pageSize: '1' });
  const queryString = qp.toString();

  const response = await axios.get('https://api-spot.weex.com/api/v2/rebate/affiliate/getAffiliateUIDs', {
    params: Object.fromEntries(qp),
    headers: {
      'ACCESS-KEY':        WEEX_API_KEY,
      'ACCESS-SIGN':       sign(WEEX_SECRET_KEY, timestamp, queryString),
      'ACCESS-PASSPHRASE': WEEX_PASSPHRASE,
      'ACCESS-TIMESTAMP':  timestamp,
      'Content-Type':      'application/json',
      'locale':            'en-US',
    },
    timeout: 15_000,
  });

  if (response.data.code !== '200') {
    throw new Error(`Weex API error: ${response.data.code}`);
  }

  const list: WeexTrader[] = response.data.data?.channelUserInfoItemList ?? [];
  return list.find(u => u.uid === uid) ?? null;
}
