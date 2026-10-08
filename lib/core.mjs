// DI-CUT booking backend — shared logic for /api/app, /api/line and /api/tick.
// Same request/response format as the earlier Apps Script version, so the app talks to either.
import crypto from 'node:crypto';

const TZ = 'Asia/Bangkok';
export const VERSION = 2;
const STATUS_TH = { confirmed: 'รอตัด', inprogress: 'กำลังตัด', done: 'ตัดเสร็จ', noshow: 'ไม่มา', cancelled: 'ยกเลิก' };
const PUBLIC_FIELDS = ['id', 'date', 'start', 'dur', 'barberId', 'status', 'serviceId', 'services', 'updatedAt'];
const C = { blue: '#0B3A9E', green: '#14975A', orange: '#C2610C', red: '#DC2F2F', gray: '#5F6B85' };

export function createCore({ db, env = {}, fetchImpl = fetch, now = () => Date.now(), log = (...a) => console.log(...a) }) {
  /* ---------- helpers ---------- */
  const parts = d => {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(d));
    const g = t => p.find(x => x.type === t).value; return { y: g('year'), m: g('month'), d: g('day'), h: +g('hour'), mi: +g('minute'), wd: g('weekday') };
  };
  const todayKey = (t = now()) => { const p = parts(t); return `${p.y}-${p.m}-${p.d}`; };
  const nowMin = (t = now()) => { const p = parts(t); return p.h * 60 + p.mi; };
  const fmt = m => { m = Math.round(m); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const thaiDate = k => { const p = parts(Date.parse(k + 'T12:00:00+07:00')), D = { Sun: 'อา.', Mon: 'จ.', Tue: 'อ.', Wed: 'พ.', Thu: 'พฤ.', Fri: 'ศ.', Sat: 'ส.' };
    const M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']; return `${D[p.wd]} ${+p.d} ${M[+p.m - 1]}`; };
  const normPhone = p => String(p || '').replace(/\D/g, '');
  const safeEq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
  const isStaff = key => !!env.STAFF_KEY && safeEq(key, env.STAFF_KEY);
  const requireStaff = key => { if (!isStaff(key)) throw httpErr('รหัสร้าน (STAFF_KEY) ไม่ถูกต้อง', 401); };
  const blocking = b => b.status === 'confirmed' || b.status === 'inprogress';
  const getCfg = async () => (await db.getKv('cfg')) || {};
  const newLinkCode = () => String(crypto.randomInt(100000, 1000000));
  const sign = (act, id) => crypto.createHmac('sha256', env.APP_SECRET || 'unset').update(act + '|' + id).digest('base64url').slice(0, 16);
  const pb = (act, id) => 'a=' + act + '&id=' + encodeURIComponent(id) + '&t=' + sign(act, id);
  const strip = b => { const o = Object.assign({}, b); delete o._base; return o; };
  async function save(b, cond) { b.updatedAt = Math.max(now(), (b.updatedAt || 0) + 1); return db.updateBooking(b, cond); }

  /* ---------- app API ---------- */
  async function list(q) {
    const staff = isStaff(q.key), since = +q.since || 0;
    const rows = await db.listBookings({ since, fromDate: todayKey(now() - 400 * 864e5) });
    return { ok: true, now: now(), staff, bookings: rows.map(b => staff ? b : Object.fromEntries(PUBLIC_FIELDS.filter(k => b[k] !== undefined).map(k => [k, b[k]]))) };
  }
  async function create(body) {
    const b = strip(body.booking || {});
    if (!b.id || !/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || !(b.start >= 0) || !(b.dur > 0) || !b.barberId) throw httpErr('ข้อมูลการจองไม่ครบ');
    if (!String(b.name || '').trim()) throw httpErr('ไม่มีชื่อลูกค้า');
    const staff = isStaff(body.key);
    if (!staff) { b.status = 'confirmed'; delete b.startedAt; delete b.doneAt; delete b.credit; if (b.pay && b.pay.status === 'paid') b.pay.status = 'review'; }
    if (b.pay && b.pay.slip) b.pay.slip = await storeSlip(b.pay.slip, b.id);
    b.notified = {}; b.createdAt = now(); b.updatedAt = now();
    const r = await db.insertBooking(b);
    if (r.ok && normPhone(b.phone).length >= 9) { try { await db.addMember({ phoneKey: normPhone(b.phone), name: String(b.name).trim(), createdAt: now() }, false); } catch (e) { log('member', e.message); } }
    if (r.duplicate) return { ok: true, booking: await db.getBooking(b.id), dup: true };
    if (r.overlap) return { ok: false, error: 'slot_taken' };
    const cfg = await getCfg(), n = cfg.notify || {};
    if (n.newBooking !== false && b.date >= todayKey() && b.status === 'confirmed') {
      const saved = await save(Object.assign(b, { notified: { new: now() } }), { notNotified: 'new' });
      if (saved && !saved.overlap) await notify(b, 'new', cfg);
    }
    if (b.pay && b.pay.status === 'review' && n.slip !== false) await notifyOwner(slipFlex(b, cfg));
    return { ok: true, booking: await db.getBooking(b.id) };
  }
  async function put(body) {
    requireStaff(body.key);
    const nb = body.booking || {}; if (!nb.id) throw httpErr('no id');
    const cur = await db.getBooking(nb.id);
    if (!cur) return create({ key: body.key, booking: nb });
    if (nb._base && (cur.updatedAt || 0) > nb._base) return { ok: false, conflict: true, booking: cur };
    if (nb.pay && /^data:/.test(nb.pay.slip || '')) nb.pay.slip = await storeSlip(nb.pay.slip, nb.id);
    const merged = Object.assign({}, cur, strip(nb), { notified: Object.assign({}, cur.notified || {}, nb.notified || {}) });
    if (cur.start !== merged.start || cur.date !== merged.date) { delete merged.notified.due; delete merged.notified.late; }
    const saved = await save(merged, { expectUpdatedAt: cur.updatedAt });
    if (!saved) return { ok: false, conflict: true, booking: await db.getBooking(nb.id) };
    if (saved.overlap) return { ok: false, error: 'slot_taken', booking: cur };
    return { ok: true, booking: saved };
  }
  async function cancel(body) {
    const b = await db.getBooking(body.id); if (!b) throw httpErr('ไม่พบคิว', 404);
    if (normPhone(b.phone) !== normPhone(body.phone) || !normPhone(body.phone)) throw httpErr('เบอร์ไม่ตรงกับการจอง', 403);
    if (b.status !== 'confirmed') throw httpErr('คิวนี้ยกเลิกไม่ได้แล้ว');
    const cfg = await getCfg(), before = cfg.cancelBefore != null ? cfg.cancelBefore : 10;
    if (b.date < todayKey() || b.date === todayKey() && nowMin() > b.start - before) throw httpErr('เลยเวลายกเลิกเองแล้ว');
    const saved = await save(Object.assign(b, { status: 'cancelled', cancelledBy: 'customer' }), { expectStatus: 'confirmed' });
    if (!saved) throw httpErr('คิวนี้เพิ่งถูกอัปเดต ลองใหม่อีกครั้ง', 409);
    if ((cfg.notify || {}).cancel !== false && b.date === todayKey()) await notify(b, 'cancel', cfg);
    return { ok: true, booking: saved };
  }
  async function slip(body) {
    const b = await db.getBooking(body.id); if (!b) throw httpErr('ไม่พบคิว', 404);
    if (normPhone(b.phone) !== normPhone(body.phone) || !normPhone(body.phone)) throw httpErr('เบอร์ไม่ตรงกับการจอง', 403);
    b.pay = Object.assign({}, b.pay || {}, { status: 'review', slip: await storeSlip(body.slip, b.id), sentAt: now() });
    const saved = await save(b); const cfg = await getCfg();
    if ((cfg.notify || {}).slip !== false) await notifyOwner(slipFlex(b, cfg));
    return { ok: true, booking: saved };
  }
  /* ---------- staff login by PIN (hashes come from the owner's settings) ---------- */
  const pinHash = (who, pin) => crypto.createHash('sha256').update((env.APP_SECRET || 'unset') + '|' + who + '|' + String(pin)).digest('hex');
  async function login(body) {
    const who = String(body.who || ''), pin = String(body.pin || '');
    if (!env.STAFF_KEY) return { ok: false, error: 'no_key' };
    const pins = await db.getKv('pins'); if (!pins || !pins[who]) return { ok: false, error: 'no_pins' };
    const fails = (await db.getKv('loginfail')) || {}, f = fails[who] || { n: 0, at: 0 };
    if (f.n >= 8 && now() - f.at < 15 * 60e3) return { ok: false, error: 'locked' };
    if (!safeEq(pinHash(who, pin), pins[who])) { fails[who] = { n: (now() - f.at < 15 * 60e3 ? f.n : 0) + 1, at: now() }; await db.setKv('loginfail', fails); return { ok: false, error: 'bad_pin' }; }
    if (f.n) { delete fails[who]; await db.setKv('loginfail', fails); }
    return { ok: true, key: env.STAFF_KEY, role: who === 'owner' ? 'owner' : 'barber' };
  }
  /* ---------- in-app chat: customer <-> shop (threads live in kv) ---------- */
  const CHAT_ID = /^[A-Za-z0-9_-]{16,40}$/;
  const cleanText = t => String(t || '').replace(/\r/g, '').trim().slice(0, 1000);
  const chatKey = id => 'chat:' + id;
  async function chatIndex() { return (await db.getKv('chatidx')) || {}; }
  const pub = (t, side) => ({ id: t.id, name: t.name, msgs: t.msgs.map(m => ({ f: m.f, t: m.t, at: m.at, by: side === 'staff' ? m.by : (m.f === 's' ? 'ร้าน' : undefined) })), unread: side === 'staff' ? t.unreadStaff : t.unreadCust });
  async function chatSend(body) {
    const id = String(body.id || ''), text = cleanText(body.text);
    if (!CHAT_ID.test(id)) throw httpErr('chat id'); if (!text) throw httpErr('พิมพ์ข้อความก่อน');
    const t = (await db.getKv(chatKey(id))) || { id, msgs: [], unreadStaff: 0, unreadCust: 0, at: now() };
    const hour = t.msgs.filter(m => m.f === 'c' && now() - m.at < 3600e3).length;
    if (hour >= 30) return { ok: false, error: 'too_many' };
    t.name = String(body.name || t.name || 'ลูกค้า').trim().slice(0, 30); t.phone = normPhone(body.phone) || t.phone || '';
    t.msgs.push({ f: 'c', t: text, at: now() }); t.msgs = t.msgs.slice(-200); t.unreadStaff = (t.unreadStaff || 0) + 1; t.at = now();
    await db.setKv(chatKey(id), t);
    const idx = await chatIndex(); idx[id] = { name: t.name, phone: t.phone, last: text.slice(0, 80), at: t.at, unread: t.unreadStaff, from: 'c' }; await db.setKv('chatidx', idx);
    if (env.LINE_TOKEN) { try { await notifyOwner(textMsg('💬 ลูกค้าทักแชทในแอพ\n' + t.name + (t.phone ? ' (' + t.phone + ')' : '') + ': ' + text.slice(0, 300) + '\n\nตอบกลับได้ในแอพ เมนู ≡ > แชทลูกค้า')); } catch (e) { log('chat notify', e.message); } }
    return { ok: true, thread: pub(t, 'cust') };
  }
  async function chatGet(body) {
    const id = String(body.id || ''); if (!CHAT_ID.test(id)) throw httpErr('chat id');
    const t = await db.getKv(chatKey(id)); if (!t) return { ok: true, thread: { id, msgs: [], unread: 0 } };
    if (body.seen && t.unreadCust) { t.unreadCust = 0; await db.setKv(chatKey(id), t); }
    return { ok: true, thread: pub(t, 'cust') };
  }
  async function chatList(body) {
    requireStaff(body.key); const idx = await chatIndex();
    const list = Object.entries(idx).map(([id, v]) => Object.assign({ id }, v)).sort((a, b) => b.at - a.at).slice(0, 100);
    return { ok: true, threads: list, unread: list.reduce((n, x) => n + (x.unread || 0), 0) };
  }
  async function chatRead(body) {
    requireStaff(body.key); const id = String(body.id || ''); if (!CHAT_ID.test(id)) throw httpErr('chat id');
    const t = await db.getKv(chatKey(id)); if (!t) throw httpErr('ไม่พบแชท', 404);
    if (t.unreadStaff) { t.unreadStaff = 0; await db.setKv(chatKey(id), t); const idx = await chatIndex(); if (idx[id]) { idx[id].unread = 0; await db.setKv('chatidx', idx); } }
    return { ok: true, thread: Object.assign(pub(t, 'staff'), { phone: t.phone }) };
  }
  async function chatReply(body) {
    requireStaff(body.key); const id = String(body.id || ''), text = cleanText(body.text);
    if (!CHAT_ID.test(id)) throw httpErr('chat id'); if (!text) throw httpErr('พิมพ์ข้อความก่อน');
    const t = await db.getKv(chatKey(id)); if (!t) throw httpErr('ไม่พบแชท', 404);
    t.msgs.push({ f: 's', t: text, at: now(), by: String(body.by || 'ร้าน').slice(0, 30) }); t.msgs = t.msgs.slice(-200);
    t.unreadCust = (t.unreadCust || 0) + 1; t.unreadStaff = 0; t.at = now(); await db.setKv(chatKey(id), t);
    const idx = await chatIndex(); idx[id] = Object.assign(idx[id] || { name: t.name, phone: t.phone }, { last: text.slice(0, 80), at: t.at, unread: 0, from: 's' }); await db.setKv('chatidx', idx);
    return { ok: true, thread: Object.assign(pub(t, 'staff'), { phone: t.phone }) };
  }

  /* ---------- members ---------- */
  const nickKey = n => String(n || '').trim().toLowerCase().replace(/^(คุณ|พี่|น้อง|k\.|khun)\s*/, '').replace(/[\s.]+/g, '');
  const dayStart = () => Date.parse(todayKey() + 'T00:00:00+07:00');
  async function memberCounts() { try { return { ok: true, count: await db.countMembers(), today: await db.countMembers(dayStart()) }; } catch (e) { log('members', e.message); return { ok: true, count: null, today: null }; } }
  async function join(body) {
    const name = String(body.name || '').trim().slice(0, 30), pk = normPhone(body.phone);
    if (!name) throw httpErr('ใส่ชื่อเล่นก่อน'); if (pk.length < 9 || pk.length > 10) throw httpErr('เบอร์ไม่ครบ');
    let cur = await db.getMember(pk);
    if (!cur) { const old = (await db.bookingsByPhone(pk)).filter(b => b.name).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0]; if (old) cur = { phoneKey: pk, name: old.name, createdAt: old.createdAt || now() }; }
    const own = body.oldPhone && normPhone(body.oldPhone) === pk; // renaming their own number
    if (cur && !own && nickKey(cur.name) !== nickKey(name)) return { ok: false, error: 'phone_taken' };
    await db.addMember({ phoneKey: pk, name: own || !cur ? name : cur.name, createdAt: cur ? cur.createdAt : now() }, true);
    return Object.assign(await memberCounts(), { back: !!cur && !own });
  }
  async function mine(body) { const p = normPhone(body.phone); if (p.length < 9) throw httpErr('เบอร์ไม่ครบ'); return { ok: true, bookings: await db.bookingsByPhone(p) }; }
  async function staffPublic() { return (await db.listStaff()).map(s => ({ staffId: s.staffId, name: s.name, role: s.role, linked: !!s.lineUserId, linkCode: s.linkCode || '' })); }
  async function config(body) {
    requireStaff(body.key);
    const c = body.cfg || {};
    const keep = { shopName: c.shopName, branch: c.branch, phone: c.phone, appUrl: c.appUrl, lateMin: c.lateMin, remindMin: c.remindMin, cancelBefore: c.cancelBefore, notify: c.notify || {}, ownerCopy: !!c.ownerCopy,
      barbers: (c.barbers || []).map(b => ({ id: String(b.id), name: String(b.name || '') })), services: (c.services || []).map(s => ({ id: String(s.id), name: String(s.name || ''), min: +s.min || 0, price: +s.price || 0 })) };
    await db.setKv('cfg', keep);
    const staff = await db.listStaff();
    const want = [{ staffId: 'owner', name: 'เจ้าของร้าน', role: 'owner' }].concat(keep.barbers.map(b => ({ staffId: b.id, name: b.name, role: 'barber' })));
    for (const w of want) {
      const s = staff.find(x => x.staffId === w.staffId);
      if (!s) await db.upsertStaff(Object.assign({}, w, { lineUserId: '', linkCode: newLinkCode() }));
      else if (s.name !== w.name || (!s.lineUserId && !s.linkCode)) await db.upsertStaff(Object.assign({}, s, { name: w.name, linkCode: !s.lineUserId && !s.linkCode ? newLinkCode() : s.linkCode }));
    }
    return { ok: true, staff: await staffPublic() };
  }
  async function unlink(body) {
    requireStaff(body.key);
    const s = (await db.listStaff()).find(x => x.staffId === body.staffId); if (!s) throw httpErr('ไม่พบช่าง', 404);
    await db.upsertStaff(Object.assign(s, { lineUserId: '', linkCode: newLinkCode(), linkedAt: null }));
    return { ok: true, staff: await staffPublic() };
  }
  async function test(body) {
    requireStaff(body.key);
    const s = (await db.listStaff()).find(x => x.staffId === body.staffId);
    if (!s || !s.lineUserId) throw httpErr('ช่างคนนี้ยังไม่ได้เชื่อม LINE');
    const r = await push(s.lineUserId, [textMsg('ทดสอบแจ้งเตือนจากระบบจองคิว ' + ((await getCfg()).shopName || '') + ' ✅\nถ้าเห็นข้อความนี้ แปลว่าเชื่อมต่อสำเร็จแล้ว')]);
    return { ok: r.ok, error: r.error };
  }
  // shop settings shown to every phone (prices, barbers, promos). PINs and keys are removed before saving.
  async function saveAppCfg(body) {
    requireStaff(body.key);
    const c = JSON.parse(JSON.stringify(body.cfg || {}));
    delete c.ownerPin; delete c.line; (c.barbers || []).forEach(b => { delete b.pin; });
    const size = JSON.stringify(c).length; if (size > 3500000) throw httpErr('ข้อมูลร้านใหญ่เกินไป ลองลดขนาดรูป');
    const app = { cfg: c, at: now() }; await db.setKv('appcfg', app);
    const src = body.cfg || {}, pins = { owner: pinHash('owner', src.ownerPin || '0000') };
    (src.barbers || []).forEach(b => { if (b && b.id) pins[String(b.id)] = pinHash(String(b.id), b.pin || '1234'); });
    await db.setKv('pins', pins);
    return { ok: true, at: app.at, size };
  }
  async function health() {
    let dbs; try { dbs = await db.health(); } catch (e) { dbs = { error: e.message }; }
    return { ok: true, version: VERSION, db: dbs, line: { token: !!env.LINE_TOKEN, secret: !!env.LINE_CHANNEL_SECRET }, staffKey: !!env.STAFF_KEY, appSecret: !!env.APP_SECRET, cron: !!env.CRON_SECRET, time: fmt(nowMin()) + ' ' + todayKey() };
  }

  /* ---------- slips ---------- */
  async function storeSlip(dataUrl, id) {
    if (!dataUrl || !/^data:image\//.test(dataUrl)) return /^https:\/\//.test(dataUrl || '') ? dataUrl : '';
    const m = dataUrl.match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/); if (!m) return '';
    const bytes = Buffer.from(m[3], 'base64'); if (bytes.length > 4 * 1024 * 1024) throw httpErr('ไฟล์สลิปใหญ่เกินไป');
    return db.uploadSlip(bytes, m[1], `${String(id).replace(/[^\w-]/g, '')}-${crypto.randomUUID()}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`);
  }

  /* ---------- reminders ---------- */
  async function tick() {
    const cfg = await getCfg(), n = cfg.notify || {}, t = todayKey(), nm = nowMin();
    const remind = cfg.remindMin != null ? cfg.remindMin : 5, late = cfg.lateMin != null ? cfg.lateMin : 15;
    const list = (await db.bookingsForDate(t)).filter(b => b.status === 'confirmed');
    let sent = 0;
    for (const b of list) {
      b.notified = b.notified || {};
      let kind = null;
      if (n.due !== false && !b.notified.due && nm >= b.start - remind && nm < b.start + Math.max(late, 1)) kind = 'due';
      else if (n.late !== false && late > 0 && !b.notified.late && nm >= b.start + late && nm < b.start + late + 60) kind = 'late';
      if (!kind) continue;
      b.notified[kind] = now();
      const saved = await save(b, { expectStatus: 'confirmed', notNotified: kind }); // claim first so two ticks never double-send
      if (saved && !saved.overlap) { await notify(b, kind, cfg); sent++; }
    }
    return { ok: true, checked: list.length, sent };
  }

  /* ---------- LINE webhook ---------- */
  function verifyLine(raw, signature) {
    if (!env.LINE_CHANNEL_SECRET || !signature) return false;
    const mac = crypto.createHmac('sha256', env.LINE_CHANNEL_SECRET).update(raw).digest('base64');
    return safeEq(mac, signature);
  }
  async function handleLine(events) {
    for (const ev of events || []) {
      try {
        const uid = ev.source && ev.source.userId;
        if (ev.type === 'follow') await reply(ev.replyToken, [textMsg('สวัสดีครับ 👋 ถ้าเป็นช่างหรือเจ้าของร้าน พิมพ์ "รหัสเชื่อมต่อ 6 หลัก" จากแอพ (แท็บร้าน > แจ้งเตือน LINE) ส่งมาในแชตนี้ได้เลย')]);
        else if (ev.type === 'message' && ev.message && ev.message.type === 'text') await onText(ev, uid, String(ev.message.text || '').trim());
        else if (ev.type === 'postback') await onPostback(ev, uid);
      } catch (e) { log('line event error', e && e.message); }
    }
  }
  const staffByUid = async uid => uid ? (await db.listStaff()).find(s => s.lineUserId === uid) || null : null;
  async function onText(ev, uid, text) {
    const code = (text.match(/(?:^|\D)(\d{6})(?:\D|$)/) || [])[1];
    if (code) {
      const s = await db.claimLinkCode(code, uid);
      if (!s) return reply(ev.replyToken, [textMsg('ไม่พบรหัสนี้ หรือรหัสถูกใช้ไปแล้ว ลองคัดลอกรหัสใหม่จากแอพอีกครั้ง')]);
      log('linked', s.staffId);
      return reply(ev.replyToken, [textMsg('เชื่อม LINE กับ "' + s.name + '" แล้ว ✅\nต่อจากนี้จะได้แจ้งเตือนคิวที่นี่ และกดเริ่มตัดในแชตได้เลย\nพิมพ์ "คิว" เพื่อดูคิววันนี้')]);
    }
    const me = await staffByUid(uid); if (!me) return;
    if (/^(คิว|คิววันนี้|queue)$/i.test(text)) return reply(ev.replyToken, [await queueFlex(me, await getCfg())]);
  }
  const qs = s => Object.fromEntries(String(s || '').split('&').map(p => { const i = p.indexOf('='); return i > 0 ? [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1))] : null; }).filter(Boolean));
  async function nextFor(barberId, date, nm, exceptId) {
    return (await db.bookingsForDate(date)).filter(x => x.id !== exceptId && x.barberId === barberId && x.status === 'confirmed' && x.start + x.dur > nm).sort((a, b) => a.start - b.start)[0] || null;
  }
  async function onPostback(ev, uid) {
    const d = qs(ev.postback && ev.postback.data), cfg = await getCfg(), me = await staffByUid(uid), rt = ev.replyToken;
    if (!me) return reply(rt, [textMsg('บัญชี LINE นี้ยังไม่ได้เชื่อมกับร้าน')]);
    if (!d.id || !safeEq(d.t, sign(d.a, d.id))) return reply(rt, [textMsg('ปุ่มนี้หมดอายุหรือไม่ถูกต้อง')]);
    const b = await db.getBooking(d.id);
    if (!b) return reply(rt, [textMsg('ไม่พบคิวนี้แล้ว')]);
    if (me.role !== 'owner' && me.staffId !== b.barberId) return reply(rt, [textMsg('คิวนี้เป็นของ' + bname(b.barberId, cfg) + ' เฉพาะช่างเจ้าของคิวหรือเจ้าของร้านกดได้')]);
    const nm = nowMin(), by = { via: 'line', by: me.staffId, at: now() }, msgs = [];
    const state = () => textMsg('คิว ' + b.name + ' ตอนนี้สถานะ "' + (STATUS_TH[b.status] || b.status) + '" แล้ว');
    if (d.a === 'start') {
      if (b.status === 'inprogress') return reply(rt, [cutFlex(b, cfg, 'คิวนี้กำลังตัดอยู่แล้ว')]);
      if (b.status !== 'confirmed') return reply(rt, [textMsg('คิว ' + b.name + ' ตอนนี้สถานะ "' + (STATUS_TH[b.status] || b.status) + '" เริ่มตัดไม่ได้')]);
      const busy = (await db.bookingsForDate(b.date)).find(x => x.id !== b.id && x.barberId === b.barberId && x.status === 'inprogress');
      if (busy) return reply(rt, [textMsg(bname(b.barberId, cfg) + ' ยังตัดให้ ' + busy.name + ' อยู่ กด "ตัดเสร็จ" คิวนั้นก่อน'), cutFlex(busy, cfg)]);
      Object.assign(b, { status: 'inprogress', startedAt: nm, lastAction: Object.assign({ act: 'start' }, by) }); delete b.doneAt;
      if (!await save(b, { expectStatus: 'confirmed' })) return reply(rt, [state()]);
      return reply(rt, [cutFlex(b, cfg)]);
    }
    if (d.a === 'done') {
      if (b.status !== 'inprogress') return reply(rt, [textMsg('คิว ' + b.name + ' ไม่ได้อยู่ในสถานะกำลังตัด')]);
      Object.assign(b, { status: 'done', doneAt: nm, lastAction: Object.assign({ act: 'done' }, by) });
      if (!await save(b, { expectStatus: 'inprogress' })) return reply(rt, [state()]);
      const early = b.start + b.dur - nm;
      msgs.push(textMsg('✅ ตัดเสร็จ ' + b.name + ' เวลา ' + fmt(nm) + (early > 0 ? '\nเสร็จก่อนเวลา ' + early + ' นาที ลูกค้าจองคิวด่วนช่วงนี้ได้แล้ว' : '')));
      const nx = await nextFor(b.barberId, b.date, nm, b.id); if (nx) msgs.push(bookingFlex(nx, cfg, 'next'));
      return reply(rt, msgs);
    }
    if (d.a === 'noshow' || d.a === 'release') {
      if (b.status !== 'confirmed') return reply(rt, [state()]);
      Object.assign(b, { status: 'noshow', lastAction: Object.assign({ act: d.a }, by) });
      if (d.a === 'release') { b.released = now(); if (b.pay && b.pay.status === 'paid') b.credit = b.pay.amount; }
      if (!await save(b, { expectStatus: 'confirmed' })) return reply(rt, [state()]);
      msgs.push(textMsg((d.a === 'release' ? '🔓 ปล่อยคิว ' : 'บันทึกว่าไม่มา: ') + b.name + ' (' + fmt(b.start) + ') แล้ว ช่วงนี้ลูกค้าคนอื่นจองได้' + (b.credit ? '\nลูกค้าโอนแล้ว ' + b.credit + ' ฿ เก็บเป็นเครดิตให้' : '')));
      const nx = await nextFor(b.barberId, b.date, nm, b.id); if (nx) msgs.push(bookingFlex(nx, cfg, 'next'));
      return reply(rt, msgs);
    }
    if (d.a === 'paid') {
      if (me.role !== 'owner') return reply(rt, [textMsg('เฉพาะเจ้าของร้านยืนยันสลิปได้')]);
      if (!b.pay) return reply(rt, [textMsg('คิวนี้ไม่มีการชำระล่วงหน้า')]);
      if (b.pay.status === 'paid') return reply(rt, [textMsg('สลิปนี้ยืนยันไปแล้ว')]);
      Object.assign(b.pay, { status: 'paid', paidAt: now() }); b.lastAction = Object.assign({ act: 'paid' }, by);
      await save(b);
      return reply(rt, [textMsg('🔒 ยืนยันสลิป ' + b.name + ' แล้ว คิวถูกล็อก')]);
    }
    return reply(rt, [textMsg('ไม่รู้จักคำสั่งนี้')]);
  }

  /* ---------- sending ---------- */
  async function notify(b, kind, cfg) {
    const st = await db.listStaff(), to = [];
    const br = st.find(s => s.staffId === b.barberId && s.lineUserId); if (br) to.push(br.lineUserId);
    const ow = st.find(s => s.role === 'owner' && s.lineUserId);
    if (ow && (cfg.ownerCopy || !br) && !to.includes(ow.lineUserId)) to.push(ow.lineUserId);
    const msg = bookingFlex(b, cfg, kind);
    for (const u of to) await push(u, [msg]);
  }
  async function notifyOwner(msg) { const ow = (await db.listStaff()).find(s => s.role === 'owner' && s.lineUserId); if (ow) await push(ow.lineUserId, [msg]); }
  const push = (to, messages) => lineApi('https://api.line.me/v2/bot/message/push', { to, messages });
  const reply = (token, messages) => token ? lineApi('https://api.line.me/v2/bot/message/reply', { replyToken: token, messages: messages.slice(0, 5) }) : null;
  async function lineApi(url, payload) {
    if (!env.LINE_TOKEN) { log('no LINE_TOKEN'); return { ok: false, error: 'ยังไม่ได้ใส่ LINE_TOKEN' }; }
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.LINE_TOKEN }, body: JSON.stringify(payload) });
      if (!r.ok) { const t = await r.text(); log('LINE', r.status, t.slice(0, 300)); return { ok: false, error: 'LINE ' + r.status + ': ' + t.slice(0, 200) }; }
      return { ok: true };
    } catch (e) { log('LINE fetch', e.message); return { ok: false, error: e.message }; }
  }
  const textMsg = t => ({ type: 'text', text: t });

  /* ---------- Flex ---------- */
  const bname = (id, cfg) => ((cfg.barbers || []).find(x => x.id === id) || {}).name || 'ช่าง';
  const svcName = (b, cfg) => (b.services && b.services.length ? b.services : [b.serviceId]).map(id => ((cfg.services || []).find(x => x.id === id) || {}).name || id).join(' + ');
  const priceOf = (b, cfg) => Math.max(0, (b.services && b.services.length ? b.services : [b.serviceId]).reduce((a, id) => a + (+((cfg.services || []).find(x => x.id === id) || {}).price || 0), 0) - (b.discount || 0) - (b.prepayOff || 0));
  const payTxt = b => !b.pay ? (b.payAtShop ? 'จ่ายที่ร้าน' : '-') : b.pay.status === 'paid' ? '🔒 โอนแล้ว ' + b.pay.amount + ' ฿' : b.pay.status === 'review' ? 'รอตรวจสลิป' : 'ยังไม่ชำระ';
  const row = (label, value, bold) => ({ type: 'box', layout: 'baseline', spacing: 'md', contents: [{ type: 'text', text: label, size: 'sm', color: C.gray, flex: 2 }, { type: 'text', text: String(value || '-'), size: 'sm', color: '#0B1220', flex: 5, wrap: true, weight: bold ? 'bold' : 'regular' }] });
  const cut20 = t => { const a = Array.from(String(t)); return a.length <= 20 ? String(t) : a.slice(0, 19).join('') + '…'; };
  const btn = (label, act, id, style, color) => Object.assign({ type: 'button', style: style || 'primary', height: 'sm', action: { type: 'postback', label: cut20(label), data: pb(act, id), displayText: String(label).slice(0, 300) } }, color ? { color } : {});
  function bubble(head, color, sub, rows, buttons, note) {
    const body = { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows.slice() };
    if (note) body.contents.push({ type: 'text', text: note, size: 'xs', color: C.gray, wrap: true, margin: 'md' });
    const b = { type: 'bubble', size: 'kilo', header: { type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '14px', contents: [{ type: 'text', text: head, color: '#FFFFFF', weight: 'bold', size: 'md', wrap: true }, { type: 'text', text: sub, color: '#FFFFFFCC', size: 'xs', wrap: true, margin: 'xs' }] }, body };
    if (buttons && buttons.length) b.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons };
    return b;
  }
  function rowsFor(b, cfg) {
    const r = [row('ลูกค้า', b.name + (b.phone ? ' · ' + b.phone : ''), true), row('บริการ', svcName(b, cfg)), row('เวลา', (b.date === todayKey() ? 'วันนี้ ' : thaiDate(b.date) + ' ') + fmt(b.start) + '–' + fmt(b.start + b.dur)), row('ราคา', priceOf(b, cfg) + ' ฿' + (b.discount ? ' (' + (b.promoTitle || 'โปร') + ')' : '')), row('ชำระ', payTxt(b))];
    if (b.note) r.push(row('ทรง', b.note)); return r;
  }
  function bookingFlex(b, cfg, kind) {
    const bn = bname(b.barberId, cfg), late = cfg.lateMin != null ? cfg.lateMin : 15, nm = nowMin(), today = b.date === todayKey();
    let head, color, sub, buttons = [], note = '';
    if (kind === 'new') { head = '📅 คิวใหม่ ' + fmt(b.start) + ' ' + b.name; color = C.blue; sub = bn + ' · ' + (today ? 'วันนี้' : thaiDate(b.date)); if (today && b.start - nm <= 30) buttons = [btn('เริ่มตัด', 'start', b.id, 'primary', C.blue)]; }
    else if (kind === 'due') { head = '⏰ ถึงคิว ' + fmt(b.start) + ' · ' + b.name; color = C.orange; sub = bn + (b.start > nm ? ' · อีก ' + (b.start - nm) + ' นาที' : ' · ถึงเวลาแล้ว'); buttons = [btn('เริ่มตัด', 'start', b.id, 'primary', C.blue), btn('ลูกค้าไม่มา', 'noshow', b.id, 'secondary')]; if (late > 0) note = 'ถ้าลูกค้ามาช้าเกิน ' + late + ' นาที (' + fmt(b.start + late) + ') ปล่อยคิวให้คนอื่นได้'; }
    else if (kind === 'late') { head = '⚠️ ' + b.name + ' เลยเวลา ' + late + ' นาที'; color = C.red; sub = bn + ' · นัด ' + fmt(b.start) + ' ยังไม่เริ่มตัด'; buttons = [btn('มาแล้ว เริ่มตัด', 'start', b.id, 'primary', C.blue), btn('ปล่อยคิวให้คนอื่น', 'release', b.id, 'primary', C.red)]; if (b.pay && b.pay.status === 'paid') note = 'ลูกค้าโอนแล้ว ถ้าปล่อยคิว ยอดจะเก็บเป็นเครดิตให้'; }
    else if (kind === 'next') { head = '➡️ คิวถัดไป ' + fmt(b.start) + ' · ' + b.name; color = C.blue; sub = bn + (b.start > nm ? ' · อีก ' + (b.start - nm) + ' นาที' : ' · ถึงเวลาแล้ว'); buttons = [btn('เริ่มตัด', 'start', b.id, 'primary', C.blue), btn('ลูกค้าไม่มา', 'noshow', b.id, 'secondary')]; }
    else { head = '❌ ลูกค้ายกเลิก ' + fmt(b.start) + ' ' + b.name; color = C.gray; sub = bn + ' · ช่วงนี้ว่างแล้ว'; }
    if (cfg.appUrl && /^https:\/\//.test(cfg.appUrl)) buttons.push({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: 'เปิดแอพ', uri: cfg.appUrl } });
    return { type: 'flex', altText: (head + ' (' + svcName(b, cfg) + ')').slice(0, 400), contents: bubble(head, color, sub, rowsFor(b, cfg), buttons, note) };
  }
  function cutFlex(b, cfg, title) {
    const st = b.startedAt != null ? b.startedAt : nowMin();
    return { type: 'flex', altText: 'กำลังตัด ' + b.name, contents: bubble(title || '✂️ เริ่มตัด ' + b.name, C.green, bname(b.barberId, cfg) + ' · เริ่ม ' + fmt(st) + ' · เสร็จประมาณ ' + fmt(st + b.dur),
      [row('บริการ', svcName(b, cfg)), row('ราคา', priceOf(b, cfg) + ' ฿'), row('ชำระ', payTxt(b))].concat(b.note ? [row('ทรง', b.note)] : []), [btn('ตัดเสร็จ', 'done', b.id, 'primary', C.green)], 'ตัดเสร็จแล้วกดปุ่มนี้ ระบบจะเปิดช่วงว่างให้ลูกค้าจองคิวด่วนทันที') };
  }
  function slipFlex(b, cfg) {
    const m = bookingFlex(b, cfg, 'new'), amt = (b.pay && b.pay.amount) || '';
    m.altText = '🧾 สลิปใหม่ ' + b.name + ' ' + amt + ' ฿';
    m.contents.header.backgroundColor = C.orange; m.contents.header.contents[0].text = '🧾 ลูกค้าส่งสลิป ' + amt + ' ฿';
    const fb = [btn('ยอดถูกต้อง ล็อกคิว', 'paid', b.id, 'primary', C.green)];
    if (b.pay && /^https:\/\//.test(b.pay.slip || '')) { fb.unshift({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: 'ดูสลิป', uri: b.pay.slip } }); if (/\.(jpg|png)$/i.test(b.pay.slip)) m.contents.hero = { type: 'image', url: b.pay.slip, size: 'full', aspectRatio: '3:4', aspectMode: 'cover' }; }
    m.contents.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: fb };
    return m;
  }
  async function queueFlex(me, cfg) {
    const nm = nowMin();
    const mine = (await db.bookingsForDate(todayKey())).filter(b => (me.role === 'owner' || b.barberId === me.staffId) && blocking(b)).sort((a, b) => a.start - b.start);
    if (!mine.length) return textMsg('วันนี้ไม่มีคิวค้างแล้ว 🎉');
    const cut = mine.find(b => b.status === 'inprogress'), nx = mine.find(b => b.status === 'confirmed');
    const rows = mine.slice(0, 12).map(b => row(fmt(b.start), (b.status === 'inprogress' ? '✂️ ' : '') + b.name + ' · ' + svcName(b, cfg) + (me.role === 'owner' ? ' (' + bname(b.barberId, cfg) + ')' : '')));
    const buttons = cut && me.role !== 'owner' ? [btn('ตัดเสร็จ ' + cut.name, 'done', cut.id, 'primary', C.green)] : nx ? [btn('เริ่มตัด ' + nx.name + ' ' + fmt(nx.start), 'start', nx.id, 'primary', C.blue)] : [];
    return { type: 'flex', altText: 'คิววันนี้ ' + mine.length + ' คิว', contents: bubble('📋 คิววันนี้ ' + mine.length + ' คิว', C.blue, (me.role === 'owner' ? 'ทั้งร้าน' : me.name) + ' · ตอนนี้ ' + fmt(nm), rows, buttons) };
  }

  /* ---------- routing ---------- */
  async function appGet(q) {
    if (q.a === 'list') return list(q);
    if (q.a === 'ping') return { ok: true, version: VERSION, staff: isStaff(q.key), line: !!env.LINE_TOKEN };
    if (q.a === 'health') return health();
    if (q.a === 'appcfg') return { ok: true, app: (await db.getKv('appcfg')) || null };
    if (q.a === 'members') return memberCounts();
    if (q.a === 'tick') { requireStaff(q.key); return tick(); }
    return { ok: true, name: 'DI-CUT booking backend', version: VERSION };
  }
  async function appPost(body) {
    switch (body.a) {
      case 'create': return create(body);
      case 'put': return put(body);
      case 'cancel': return cancel(body);
      case 'slip': return slip(body);
      case 'mine': return mine(body);
      case 'join': return join(body);
      case 'login': return login(body);
      case 'chat_send': return chatSend(body);
      case 'chat_get': return chatGet(body);
      case 'chat_list': return chatList(body);
      case 'chat_read': return chatRead(body);
      case 'chat_reply': return chatReply(body);
      case 'config': return config(body);
      case 'staff': requireStaff(body.key); return { ok: true, staff: await staffPublic() };
      case 'test': return test(body);
      case 'unlink': return unlink(body);
      case 'appcfg': return saveAppCfg(body);
      default: throw httpErr('unknown action');
    }
  }
  return { appGet, appPost, handleLine, verifyLine, tick, health, sign, isCron: k => !!env.CRON_SECRET && safeEq(k, env.CRON_SECRET), todayKey, nowMin };
}

export function httpErr(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/* ---------- Web handler wrappers (used by api/*.mjs) ---------- */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
export const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS) });
export const preflight = () => new Response(null, { status: 204, headers: CORS });
export async function guard(fn) {
  try { return json(await fn()); }
  catch (e) { const st = e.status || 500; if (st >= 500 && st !== 503) console.error(e); return json({ ok: false, error: st === 503 || st < 500 ? e.message : 'server error' }, st >= 500 ? st : 200); }
}
