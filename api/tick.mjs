// Reminder check. Call every minute: https://<your-app>.vercel.app/api/tick?key=<CRON_SECRET>
// (Vercel Hobby cron is once a day, so use a free pinger such as cron-job.org; the shop's open app also calls this.)
import { coreFromEnv } from '../lib/setup.mjs';
import { json, guard } from '../lib/core.mjs';
export default {
  async fetch(request) {
    const core = coreFromEnv(), u = new URL(request.url);
    const key = u.searchParams.get('key') || (request.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!core.isCron(key)) return json({ ok: false, error: 'unauthorized' }, 401);
    return guard(() => core.tick());
  },
};
