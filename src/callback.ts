import axios from 'axios';

export async function resumeBot(returnUrl: string, status: string, jwtToken: string, message?: string): Promise<void> {
  try {
    await axios.post(returnUrl, {
      data: { status, message: message ?? '' },
    }, {
      timeout: 10_000,
      headers: {
        Authorization: `Bearer ${jwtToken}`,
      },
    });
    console.log(`[callback] ${status} → ${returnUrl}`);
  } catch (err: any) {
    console.error('[callback] failed to resume bot', {
      returnUrl,
      status,
      httpStatus: err?.response?.status,
      response: err?.response?.data,
    });
  }
}