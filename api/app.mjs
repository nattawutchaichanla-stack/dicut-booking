// App API: GET ?a=list|ping|health|tick|members , POST {a:create|put|cancel|slip|mine|join|login|config|staff|test|unlink}
import { coreFromEnv } from '../lib/setup.mjs';
import { guard, preflight, json } from '../lib/core.mjs';
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return preflight();
    const core = coreFromEnv();
    if (request.method === 'GET') return guard(() => core.appGet(Object.fromEntries(new URL(request.url).searchParams)));
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
    let body; try { body = JSON.parse(await request.text() || '{}'); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
    return guard(() => core.appPost(body));
  },
};
