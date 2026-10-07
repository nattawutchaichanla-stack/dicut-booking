// Storage adapters. Both expose the same async interface used by core.mjs.
//   Supabase (production): talks to PostgREST + Storage over HTTPS, no npm packages needed.
//   Memory (tests): same behaviour in-process, including the "no overlapping queue" rule.

const BLOCKING = ['confirmed', 'inprogress'];
const rowToBooking = r => Object.assign({}, r.data || {}, { id: r.id, date: r.date, start: r.start, dur: r.dur, barberId: r.barber_id, status: r.status, phone: (r.data && r.data.phone) || '', updatedAt: Number(r.updated_at) || 0 });
const bookingToRow = b => ({ id: b.id, date: b.date, start: b.start, dur: b.dur, barber_id: b.barberId, status: b.status, phone_key: String(b.phone || '').replace(/\D/g, ''), data: b, updated_at: b.updatedAt });

/* ============================ Supabase ============================ */
export function supabaseDb({ url, key, fetchImpl = fetch }) {
  const base = String(url || '').replace(/\/+$/, '');
  const auth = { apikey: key };
  if (/^eyJ/.test(key || '')) auth.Authorization = 'Bearer ' + key; // legacy service_role JWT
  async function rest(path, { method = 'GET', body, prefer } = {}) {
    const h = Object.assign({ 'Content-Type': 'application/json' }, auth);
    if (prefer) h.Prefer = prefer;
    const r = await fetchImpl(base + '/rest/v1/' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!r.ok) { const err = new Error('db ' + r.status + ' ' + (data && data.message || text).toString().slice(0, 200)); err.status = r.status; err.code = data && data.code; throw err; }
    return data;
  }
  const enc = encodeURIComponent;
  const filt = (cond = {}) => {
    const f = [];
    if (cond.expectStatus) f.push('status=eq.' + enc(cond.expectStatus));
    if (cond.expectUpdatedAt != null) f.push('updated_at=eq.' + enc(cond.expectUpdatedAt));
    if (cond.notNotified) f.push('data->notified->>' + enc(cond.notNotified) + '=is.null');
    return f.length ? '&' + f.join('&') : '';
  };
  return {
    kind: 'supabase',
    async health() {
      const out = {};
      for (const t of ['bookings', 'staff', 'kv']) { try { await rest(t + '?select=*&limit=1'); out[t] = true; } catch (e) { out[t] = false; out.error = e.message; } }
      return out;
    },
    async listBookings({ since = 0, fromDate } = {}) {
      let q = 'bookings?select=*&order=updated_at.asc&limit=5000';
      if (since) q += '&updated_at=gt.' + since; else if (fromDate) q += '&date=gte.' + enc(fromDate);
      return (await rest(q)).map(rowToBooking);
    },
    async bookingsForDate(date) { return (await rest('bookings?select=*&date=eq.' + enc(date))).map(rowToBooking); },
    async bookingsByPhone(phoneKey) { return (await rest('bookings?select=*&phone_key=eq.' + enc(phoneKey))).map(rowToBooking); },
    async getBooking(id) { const r = await rest('bookings?select=*&id=eq.' + enc(id)); return r && r[0] ? rowToBooking(r[0]) : null; },
    async insertBooking(b) {
      try { await rest('bookings', { method: 'POST', body: bookingToRow(b), prefer: 'return=minimal' }); return { ok: true }; }
      catch (e) { if (e.code === '23P01' || e.status === 409 && e.code !== '23505') return { ok: false, overlap: true }; if (e.code === '23505') return { ok: false, duplicate: true }; throw e; }
    },
    // conditional update; returns the saved booking, or null when the condition no longer holds
    async updateBooking(b, cond) {
      try {
        const r = await rest('bookings?id=eq.' + enc(b.id) + filt(cond), { method: 'PATCH', body: bookingToRow(b), prefer: 'return=representation' });
        return r && r[0] ? rowToBooking(r[0]) : null;
      } catch (e) { if (e.code === '23P01') return { overlap: true }; throw e; }
    },
    async listStaff() { return (await rest('staff?select=*&order=staff_id')).map(s => ({ staffId: s.staff_id, name: s.name, role: s.role, lineUserId: s.line_user_id || '', linkCode: s.link_code || '', linkedAt: s.linked_at })); },
    async upsertStaff(s) { await rest('staff?on_conflict=staff_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { staff_id: s.staffId, name: s.name, role: s.role, line_user_id: s.lineUserId || null, link_code: s.linkCode || null, linked_at: s.linkedAt || null } }); },
    async claimLinkCode(code, uid) { // atomic: only one LINE account can use a code
      const r = await rest('staff?link_code=eq.' + enc(code), { method: 'PATCH', prefer: 'return=representation', body: { line_user_id: uid, link_code: null, linked_at: new Date().toISOString() } });
      return r && r[0] ? { staffId: r[0].staff_id, name: r[0].name, role: r[0].role } : null;
    },
    async getKv(k) { const r = await rest('kv?select=value&key=eq.' + enc(k)); return r && r[0] ? r[0].value : null; },
    async setKv(k, v) { await rest('kv?on_conflict=key', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { key: k, value: v } }); },
    async uploadSlip(bytes, contentType, path) {
      const r = await fetchImpl(base + '/storage/v1/object/slips/' + path, { method: 'POST', headers: Object.assign({ 'Content-Type': contentType, 'x-upsert': 'true' }, auth), body: bytes });
      if (!r.ok) throw new Error('slip upload ' + r.status + ' ' + (await r.text()).slice(0, 200));
      return base + '/storage/v1/object/public/slips/' + path;
    },
  };
}

/* ============================ Memory ============================ */
export function memoryDb() {
  const rows = new Map(), staff = new Map(), kv = new Map(), slips = new Map();
  const clone = o => JSON.parse(JSON.stringify(o));
  const overlaps = (a, b) => a.id !== b.id && a.barberId === b.barberId && a.date === b.date && BLOCKING.includes(a.status) && BLOCKING.includes(b.status) && a.start < b.start + b.dur && b.start < a.start + a.dur;
  const condOk = (cur, c = {}) => (!c.expectStatus || cur.status === c.expectStatus) && (c.expectUpdatedAt == null || cur.updatedAt === c.expectUpdatedAt) && (!c.notNotified || !(cur.notified && cur.notified[c.notNotified]));
  return {
    kind: 'memory', rows, staff, kv, slips,
    async health() { return { bookings: true, staff: true, kv: true }; },
    async listBookings({ since = 0, fromDate } = {}) { return [...rows.values()].filter(b => since ? b.updatedAt > since : !fromDate || b.date >= fromDate).sort((a, b) => a.updatedAt - b.updatedAt).map(clone); },
    async bookingsForDate(d) { return [...rows.values()].filter(b => b.date === d).map(clone); },
    async bookingsByPhone(p) { return [...rows.values()].filter(b => String(b.phone || '').replace(/\D/g, '') === p).map(clone); },
    async getBooking(id) { return rows.has(id) ? clone(rows.get(id)) : null; },
    async insertBooking(b) {
      if (rows.has(b.id)) return { ok: false, duplicate: true };
      if ([...rows.values()].some(x => overlaps(x, b))) return { ok: false, overlap: true };
      rows.set(b.id, clone(b)); return { ok: true };
    },
    async updateBooking(b, cond) {
      const cur = rows.get(b.id); if (!cur || !condOk(cur, cond)) return null;
      if ([...rows.values()].some(x => overlaps(x, b))) return { overlap: true };
      rows.set(b.id, clone(b)); return clone(b);
    },
    async listStaff() { return [...staff.values()].map(clone).sort((a, b) => a.staffId.localeCompare(b.staffId)); },
    async upsertStaff(s) { staff.set(s.staffId, Object.assign({}, staff.get(s.staffId) || {}, clone(s))); },
    async claimLinkCode(code, uid) { const s = [...staff.values()].find(x => x.linkCode && x.linkCode === code); if (!s) return null; s.lineUserId = uid; s.linkCode = ''; s.linkedAt = new Date().toISOString(); return { staffId: s.staffId, name: s.name, role: s.role }; },
    async getKv(k) { return kv.has(k) ? clone(kv.get(k)) : null; },
    async setKv(k, v) { kv.set(k, clone(v)); },
    async uploadSlip(bytes, ct, path) { slips.set(path, bytes); return 'https://example.supabase.co/storage/v1/object/public/slips/' + path; },
  };
}
