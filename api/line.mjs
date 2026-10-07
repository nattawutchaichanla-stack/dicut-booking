// LINE Messaging API webhook. Set https://<your-app>.vercel.app/api/line as the Webhook URL.
import { coreFromEnv } from '../lib/setup.mjs';
import { json } from '../lib/core.mjs';
export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ ok: true, hint: 'LINE webhook endpoint' });
    const raw = await request.text(), core = coreFromEnv();
    if (!core.verifyLine(raw, request.headers.get('x-line-signature'))) return json({ ok: false, error: 'bad signature' }, 401);
    let body; try { body = JSON.parse(raw); } catch (e) { return json({ ok: false }, 400); }
    await core.handleLine(body.events || []);
    return json({ ok: true });
  },
};
