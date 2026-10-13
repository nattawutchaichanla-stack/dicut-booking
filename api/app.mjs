// App API: GET ?a=list|ping|health|tick|members|gfx_idx|gfx_get , POST {a:create|put|cancel|slip|mine|join|login|gfx_put|chat_send|chat_get|chat_list|chat_read|chat_reply|config|staff|test|unlink}
import { coreFromEnv } from '../lib/setup.mjs';
import { guard, preflight, json } from '../lib/core.mjs';
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return preflight();
    const core = coreFromEnv();
    if (request.method === 'GET') {
      const q = Object.fromEntries(new URL(request.url).searchParams);
      if (q.a === 'photo') { // barber photo for LINE cards
        try { const p = await core.photo(q); if (p) return new Response(p.bytes, { headers: { 'Content-Type': p.type, 'Cache-Control': 'public, max-age=86400' } }); } catch (e) {}
        return new Response('not found', { status: 404 });
      }
      return guard(() => core.appGet(q));
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
    let body; try { body = JSON.parse(await request.text() || '{}'); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
    return guard(() => core.appPost(body));
  },
};
