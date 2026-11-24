/* Noyau des règles de gestion — partagé navigateur / serveur / tests.
   Tout est un journal d'opérations ; l'état est recalculé de façon déterministe.
   Les couleurs ne sont JAMAIS stockées : elles sont calculées (impossible de « forcer » le vert). */
(function (root) {
  'use strict';

  /* ---------- utilitaires ---------- */
  function sha256(msg) {
    const u = unescape(encodeURIComponent(msg));
    const bytes = [];
    for (let i = 0; i < u.length; i++) bytes.push(u.charCodeAt(i));
    const primes = [];
    for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
    const frac = x => x - Math.floor(x);
    const K = primes.map(p => Math.floor(frac(Math.cbrt(p)) * 4294967296) >>> 0);
    const H = primes.slice(0, 8).map(p => Math.floor(frac(Math.sqrt(p)) * 4294967296) >>> 0);
    const bits = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const hi = Math.floor(bits / 4294967296), lo = bits >>> 0;
    [hi, lo].forEach(w => { for (let s = 24; s >= 0; s -= 8) bytes.push((w >>> s) & 255); });
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < bytes.length; o += 64) {
      const w = new Array(64);
      for (let i = 0; i < 16; i++) w[i] = (bytes[o + 4 * i] << 24) | (bytes[o + 4 * i + 1] << 16) | (bytes[o + 4 * i + 2] << 8) | bytes[o + 4 * i + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }
  const hashPin = (agentId, pin) => sha256('baes:' + agentId + ':' + pin);

  const pad = n => String(n).padStart(2, '0');
  function today(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addYear(day) {
    const [y, m, d] = day.split('-').map(Number);
    return (y + 1) + '-' + pad(m) + '-' + pad(m === 2 && d === 29 ? 28 : d);
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const natCmp = (a, b) => String(a).localeCompare(String(b), 'fr', { numeric: true });

  /* ---------- anomalies ---------- */
  const ANOM_LIGHT = { batterie: 'Batterie à changer', telecommande: 'Télécommande à recâbler', bloc: 'Bloc à remplacer', autre: 'Autre anomalie' };
  const ANOM_REMOTE = { recablage: 'À recâbler', remplacement: 'À remplacer', autre: 'Autre anomalie' };
  const anomLabel = a => (a.kind === 'remote' ? ANOM_REMOTE : ANOM_LIGHT)[a.code] + (a.comment ? ' — ' + a.comment : '');

  /* ---------- état ---------- */
  const COL = { site: 'sites', building: 'buildings', floor: 'floors', light: 'lights', remote: 'remotes' };
  function newState() {
    return { agents: {}, sites: {}, buildings: {}, floors: {}, lights: {}, remotes: {}, types: {}, anomalies: {}, history: {} };
  }
  function addHist(s, equipId, op, kind, text) {
    (s.history[equipId] = s.history[equipId] || []).push({ ts: op.ts, day: op.day, agent: op.agent ? op.agent.name : '?', kind, text });
  }
  const equipOf = (s, id) => s.lights[id] || s.remotes[id];
  const hasOpen = (s, id) => Object.values(s.anomalies).some(a => a.equipId === id && !a.resolvedDay);

  function apply(s, op) {
    const d = op.d || {};
    switch (op.type) {
      case 'agent.add':
        s.agents[d.id] = Object.assign(s.agents[d.id] || {}, { id: d.id, name: d.name, pinHash: d.pinHash, active: true });
        break;
      case 'agent.update':
        if (s.agents[d.id]) Object.assign(s.agents[d.id], d.f);
        break;
      case 'type.add':
        s.types[d.id] = { id: d.id, cat: d.cat, name: d.name };
        break;
      case 'ent.set': {
        const col = COL[d.kind]; if (!col) return;
        let e = s[col][d.id]; const isNew = !e;
        if (isNew) { e = s[col][d.id] = { id: d.id }; if (d.kind === 'light' || d.kind === 'remote') e.gen = 0; }
        Object.assign(e, d.f);
        if (d.kind === 'light' || d.kind === 'remote') {
          if (isNew) addHist(s, d.id, op, 'create', 'Fiche créée');
          else addHist(s, d.id, op, 'edit', 'Fiche modifiée');
        }
        break;
      }
      case 'ent.del': {
        const col = COL[d.kind]; if (col && s[col][d.id]) s[col][d.id].del = true;
        break;
      }
      case 'anom.add': {
        const e = equipOf(s, d.equipId);
        if (!e || e.del || (d.gen || 0) !== e.gen) return;       // opération périmée (équipement remplacé entre-temps)
        (d.items || []).forEach(it => {
          if (s.anomalies[it.id]) return;
          s.anomalies[it.id] = { id: it.id, equipId: d.equipId, kind: d.kind, code: it.code, comment: it.comment || '', gen: e.gen,
            declaredBy: op.agent && op.agent.name, declaredTs: op.ts, declaredDay: op.day };
          addHist(s, d.equipId, op, 'anomaly', 'Anomalie déclarée : ' + anomLabel(s.anomalies[it.id]));
        });
        break;
      }
      case 'anom.done': {
        const a = s.anomalies[d.id];
        if (!a || a.resolvedDay) return;                          // déjà validée : la première validation est retenue
        const e = equipOf(s, a.equipId);
        a.resolvedDay = op.day; a.resolvedTs = op.ts; a.resolvedBy = op.agent && op.agent.name;
        addHist(s, a.equipId, op, 'done', 'Action réalisée : ' + anomLabel(a));
        // « Action réalisée » vaut contrôle
        if (e && a.gen === e.gen && (!e.lastControl || op.day > e.lastControl)) e.lastControl = op.day;
        break;
      }
      case 'ctl.add': {
        const e = equipOf(s, d.equipId);
        if (!e || e.del || (d.gen || 0) !== e.gen) return;
        if (!e.lastControl || op.day > e.lastControl) e.lastControl = op.day;
        addHist(s, d.equipId, op, 'control', 'Contrôle annuel validé');
        break;
      }
      case 'ctl.bulk': {
        (d.ids || []).forEach(it => {
          const e = s.lights[it.id];
          if (!e || e.del || it.gen !== e.gen || hasOpen(s, it.id)) return; // sécurité : jamais un éclairage rouge
          if (!e.lastControl || op.day > e.lastControl) e.lastControl = op.day;
          addHist(s, it.id, op, 'control', 'Contrôle annuel validé (validation collective)');
        });
        break;
      }
      case 'equip.replace': {
        const e = equipOf(s, d.equipId);
        if (!e || (d.gen || 0) !== e.gen) return;                 // déjà remplacé par un autre agent
        e.gen += 1;
        Object.keys(s.anomalies).forEach(k => { if (s.anomalies[k].equipId === d.equipId) delete s.anomalies[k]; });
        delete s.history[d.equipId];                              // aucun historique antérieur conservé
        Object.assign(e, d.f, { replacedAt: d.f.replacedAt || op.day });
        e.lastControl = e.replacedAt;                             // le remplacement vaut contrôle
        // remoteId (association télécommande) et numéro sont conservés
        addHist(s, d.equipId, op, 'replace', 'Équipement remplacé : ' + (e.typeName || '') + ' ' + (e.ref || ''));
        break;
      }
    }
  }
  function reduce(ops, base) { const s = base || newState(); ops.forEach(o => apply(s, o)); return s; }

  /* ---------- sélecteurs ---------- */
  const alive = o => o && !o.del;
  const sites = s => Object.values(s.sites).filter(alive).sort((a, b) => natCmp(a.name, b.name));
  const buildingsOf = (s, siteId) => Object.values(s.buildings).filter(b => alive(b) && b.siteId === siteId).sort((a, b) => natCmp(a.name, b.name));
  const floorsOf = (s, bId) => Object.values(s.floors).filter(f => alive(f) && f.buildingId === bId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || natCmp(a.name, b.name));
  function lightsOf(s, floorId) {
    const f = s.floors[floorId]; if (!alive(f) || !alive(s.buildings[f.buildingId])) return [];
    return Object.values(s.lights).filter(l => alive(l) && l.floorId === floorId).sort((a, b) => natCmp(a.number, b.number));
  }
  const remotesOf = (s, siteId) => Object.values(s.remotes).filter(r => alive(r) && r.siteId === siteId).sort((a, b) => natCmp(a.number, b.number));
  function remoteOfLight(s, l) { const r = l.remoteId && s.remotes[l.remoteId]; return alive(r) ? r : null; }
  const lightsOfRemote = (s, rid) => Object.values(s.lights).filter(l => alive(l) && l.remoteId === rid);
  const openAnoms = (s, id) => Object.values(s.anomalies).filter(a => a.equipId === id && !a.resolvedDay).sort((a, b) => (a.declaredTs || '').localeCompare(b.declaredTs || ''));
  const nextControl = e => (e.lastControl ? addYear(e.lastControl) : null);
  /* rouge > orange > vert ; l'échéance reste calculée même quand l'équipement est rouge */
  function status(s, e, now) {
    now = now || today();
    const open = openAnoms(s, e.id).length, next = nextControl(e);
    const due = !next || now >= next;                           // échéance : le jour même
    const color = open ? 'red' : due ? 'orange' : 'green';
    return { color, open, due, next, overdue: !!next && now > next, never: !next };
  }
  function siteChain(s, l) {
    const f = s.floors[l.floorId], b = f && s.buildings[f.buildingId], si = b && s.sites[b.siteId];
    return { floor: f, building: b, site: si };
  }

  const api = { sha256, hashPin, today, addYear, uid, natCmp, ANOM_LIGHT, ANOM_REMOTE, anomLabel, COL, newState, apply, reduce,
    sites, buildingsOf, floorsOf, lightsOf, remotesOf, remoteOfLight, lightsOfRemote, openAnoms, nextControl, status, siteChain, equipOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Core = api;
})(typeof self !== 'undefined' ? self : this);
