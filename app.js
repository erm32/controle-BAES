/* Interface mobile — éclairages de sécurité. Toute la logique métier est dans core.js ; ici : écrans, saisie, stockage local. */
(function () {
  'use strict';
  const C = Core, Eng = EngineLib.Engine;
  const $app = document.getElementById('app'), $modal = document.getElementById('modal'), $toast = document.getElementById('toast');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }, del(k) { try { localStorage.removeItem(k); } catch (e) { /* idem */ } } };
  const fmt = d => d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '—';
  const fmtTime = ts => { try { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); } catch (e) { return ''; } };
  const plural = (n, one, many) => n + ' ' + (n > 1 ? many : one);

  /* ---------- stockage local (IndexedDB) ---------- */
  function idbStore() {
    const open = new Promise((res, rej) => {
      const r = indexedDB.open('baes', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('confirmed', { keyPath: 'seq' }); d.createObjectStore('pending', { keyPath: 'id' }); d.createObjectStore('meta'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const getAll = name => open.then(db => new Promise((res, rej) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const getMeta = k => open.then(db => new Promise((res, rej) => { const r = db.transaction('meta').objectStore('meta').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const tx = (names, fn) => open.then(db => new Promise((res, rej) => { const t = db.transaction(names, 'readwrite'); fn(t); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }));
    return {
      async loadAll() { const [c, p] = await Promise.all([getAll('confirmed'), getAll('pending')]); return { confirmed: c, pending: p, cursor: (await getMeta('cursor')) || 0, lastSync: await getMeta('lastSync') }; },
      addPending: o => tx('pending', t => t.objectStore('pending').put(o)),
      removePending: ids => tx('pending', t => ids.forEach(i => t.objectStore('pending').delete(i))),
      addConfirmed: (ops, cursor) => tx(['confirmed', 'meta'], t => { ops.forEach(o => t.objectStore('confirmed').put(o)); t.objectStore('meta').put(cursor, 'cursor'); }),
      setMeta: (k, v) => tx('meta', t => t.objectStore('meta').put(v, k)),
    };
  }
  /* Le serveur peut être le même que l'application (adresse vide) ou distant (Google Apps Script). La clé voyage dans le corps,
     en text/plain : c'est ce qui évite la pré-vérification CORS, que Google Apps Script ne gère pas. */
  const serverUrl = () => (LS.get('baes.server') || '').trim() || 'api/sync';
  const net = { async sync(cursor, ops) {
    const r = await fetch(serverUrl(), { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, redirect: 'follow', body: JSON.stringify({ key: LS.get('baes.key') || '', cursor, ops }) });
    let data = null; try { data = await r.json(); } catch (e) { /* réponse non JSON */ }
    if (r.status === 401 || (data && data.error === 'cle')) { const e = new Error('cle'); e.code = 401; throw e; }
    if (!r.ok || !data || !Array.isArray(data.ops)) throw new Error('serveur ' + r.status);
    return data;
  } };

  let eng, session = null, quiet = false, dirty = false, lastTouch = 0, modalOpen = false, syncTimer = null;
  const S = () => eng.state;
  const ui = { stack: [{ s: 'home' }], sel: { site: '', building: '', floor: '' }, setupErr: '' };
  const cur = () => ui.stack[ui.stack.length - 1];
  try { Object.assign(ui.sel, JSON.parse(LS.get('baes.sel') || '{}')); } catch (e) { /* sélection absente */ }
  const saveSel = () => LS.set('baes.sel', JSON.stringify(ui.sel));

  /* ---------- navigation ---------- */
  function go(s, p) { ui.stack.push(Object.assign({ s }, p)); history.pushState({ d: ui.stack.length }, ''); render(); window.scrollTo(0, 0); }
  window.addEventListener('popstate', () => {
    if (modalOpen) { closeModal(null); history.pushState({ d: ui.stack.length }, ''); return; } // « retour » ferme la fenêtre ouverte sans quitter l'écran
    if (ui.stack.length > 1) { ui.stack.pop(); render(); }
  });
  history.replaceState({ d: 1 }, '');

  /* ---------- fenêtres, messages ---------- */
  function toast(msg) { $toast.textContent = msg; $toast.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { $toast.hidden = true; }, 2600); }
  let modalResolve = null;
  function closeModal(r) { if (!modalOpen) return; modalOpen = false; $modal.hidden = true; $modal.innerHTML = ''; const f = modalResolve; modalResolve = null; if (f) f(r); flush(); }
  function fieldHtml(f) {
    const id = 'mf-' + f.id, val = f.value == null ? '' : f.value;
    if (f.type === 'note') return '<div class="mut" style="margin-top:8px">' + f.html + '</div>';
    if (f.type === 'checks') return (f.label ? '<label class="f">' + esc(f.label) + '</label>' : '') + Object.keys(f.options).map(k => '<label class="chk"><input type="checkbox" data-chk="' + f.id + '" value="' + k + '"><span>' + esc(f.options[k]) + '</span></label>').join('');
    let inner;
    if (f.type === 'select') inner = '<select id="' + id + '">' + f.options.map(o => '<option value="' + esc(o.v) + '"' + (o.v === val ? ' selected' : '') + '>' + esc(o.l) + '</option>').join('') + '</select>';
    else if (f.type === 'textarea') inner = '<textarea id="' + id + '">' + esc(val) + '</textarea>';
    else inner = '<input id="' + id + '" type="' + (f.type || 'text') + '" value="' + esc(val) + '"' + (f.list ? ' list="dl-' + f.id + '"' : '') + (f.inputmode ? ' inputmode="' + f.inputmode + '"' : '') + (f.maxlength ? ' maxlength="' + f.maxlength + '"' : '') + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + ' autocomplete="off"' + (f.cls ? ' class="' + f.cls + '"' : '') + '>' + (f.list ? '<datalist id="dl-' + f.id + '">' + f.list.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist>' : '');
    return '<label class="f" for="' + id + '">' + esc(f.label) + '</label>' + inner;
  }
  function modal(cfg) {
    return new Promise(resolve => {
      if (modalOpen) closeModal(null);
      const buttons = cfg.buttons || [{ id: 'ok', label: cfg.ok || 'Enregistrer', cls: 'pri' }];
      $modal.innerHTML = '<div class="box" role="dialog" aria-modal="true"><h3>' + esc(cfg.title) + '</h3>' + (cfg.intro || '') + (cfg.fields || []).map(fieldHtml).join('') + '<div class="err" id="merr"></div><div class="row" style="margin-top:14px;flex-wrap:wrap">' +
        buttons.map(b => '<button class="btn ' + (b.cls || '') + '" data-b="' + b.id + '">' + esc(b.label) + '</button>').join('') + '<button class="btn" data-b="">Annuler</button></div></div>';
      $modal.hidden = false; modalOpen = true; modalResolve = resolve; $toast.hidden = true;
      const first = $modal.querySelector('input:not([type=checkbox]),select,textarea'); if (first && cfg.autofocus) first.focus();
      $modal.onclick = e => {
        if (e.target === $modal) return closeModal(null);
        const b = e.target.closest('[data-b]'); if (!b) return;
        if (b.dataset.b === '') return closeModal(null);
        const v = {};
        (cfg.fields || []).forEach(f => {
          if (f.type === 'checks') v[f.id] = [...$modal.querySelectorAll('[data-chk="' + f.id + '"]:checked')].map(x => x.value);
          else if (f.type !== 'note') { const el = document.getElementById('mf-' + f.id); v[f.id] = el ? el.value.trim() : ''; }
        });
        const err = cfg.validate && cfg.validate(b.dataset.b, v);
        if (err) { document.getElementById('merr').textContent = err; return; }
        closeModal({ btn: b.dataset.b, v });
      };
    });
  }

  /* ---------- rendu différé (jamais pendant une saisie) ---------- */
  const typing = () => { const a = document.activeElement; return !!a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && $app.contains(a); };
  function requestRender() { if (quiet) return; if (modalOpen || typing()) { dirty = true; return; } render(); }
  function flush() { if (dirty && !modalOpen && !typing() && Date.now() - lastTouch > 800) render(); }
  document.addEventListener('pointerdown', () => { lastTouch = Date.now(); }, true);
  setInterval(flush, 1500);

  async function push(type, d) { await eng.push(type, d); scheduleSync(); }
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => { if (LS.get('baes.key')) eng.sync(); }, 1200); }

  /* ---------- aides d'affichage ---------- */
  const COLORS = { green: 'Conforme', orange: 'Contrôle à effectuer', red: 'Anomalie en cours' };
  function stLabel(st) {
    if (st.open) return 'Anomalie en cours';
    if (st.never) return 'Jamais contrôlé';
    if (st.overdue) return 'Contrôle en retard';
    if (st.due) return 'Contrôle à effectuer (échéance aujourd\'hui)';
    return 'Conforme';
  }
  const badge = (st) => '<span class="badge ' + st.color + '">' + esc(stLabel(st)) + '</span>';
  const siteName = id => (S().sites[id] || {}).name || '?';
  function chainOf(l) { const c = C.siteChain(S(), l); return { site: c.site, building: c.building, floor: c.floor }; }
  const chainText = l => { const c = chainOf(l); return [c.site && c.site.name, c.building && c.building.name, c.floor && c.floor.name].join(' › '); };
  const typeNames = cat => Object.values(S().types).filter(t => t.cat === cat).map(t => t.name).sort(C.natCmp);
  const openCount = () => interventions('').length;
  function top(title, back) {
    const pend = eng.pending.length;
    const online = navigator.onLine !== false && !eng.lastError;
    const label = eng.syncing ? 'Synchro…' : eng.lastError ? (eng.lastError.code === 401 ? 'Clé refusée' : 'Hors ligne') + (pend ? ' · ' + pend : '') : pend ? pend + ' en attente' : 'À jour';
    const cls = eng.syncing || pend ? 'wait' : online ? '' : 'off';
    return '<header class="top">' + (back ? '<button data-a="back" aria-label="Retour">‹</button>' : '') + '<h1>' + esc(title) + '</h1><button class="sync" data-a="syncnow" aria-label="Synchronisation"><span class="dot ' + (eng.lastError ? 'off' : cls) + '"></span>' + esc(label) + '</button></header>';
  }
  const opts = (items, sel, ph) => '<option value="">' + esc(ph) + '</option>' + items.map(i => '<option value="' + esc(i.id) + '"' + (i.id === sel ? ' selected' : '') + '>' + esc(i.name) + '</option>').join('');

  /* ---------- interventions (anomalies ouvertes) ---------- */
  function interventions(siteId) {
    const s = S(), rows = [];
    Object.values(s.anomalies).forEach(a => {
      if (a.resolvedDay) return;
      const e = C.equipOf(s, a.equipId); if (!e || e.del) return;
      if (a.kind === 'light') {
        const c = chainOf(e); if (!c.site || c.site.del || !c.building || c.building.del || !c.floor || c.floor.del) return;
        if (siteId && c.site.id !== siteId) return;
        rows.push({ a, e, kind: 'light', site: c.site.name, building: c.building.name, floor: c.floor.name, num: e.number });
      } else {
        const si = s.sites[e.siteId]; if (!si || si.del) return;
        if (siteId && si.id !== siteId) return;
        rows.push({ a, e, kind: 'remote', site: si.name, building: '', floor: '', num: e.number });
      }
    });
    return rows.sort((x, y) => (x.a.declaredDay || '').localeCompare(y.a.declaredDay || '') || C.natCmp(x.num, y.num));
  }

  /* ---------- écrans ---------- */
  function renderSetup() {
    return '<div class="center"><h1>Éclairages de sécurité</h1><p class="mut">Première utilisation : saisissez la clé d\'accès fournie avec le serveur. Elle n\'est demandée qu\'une fois sur ce téléphone.</p>' +
      '<label class="f">Adresse du serveur (laisser vide si l\'application est hébergée avec son serveur)</label><input type="text" id="srv" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(LS.get('baes.server') || '') + '"><label class="f">Clé d\'accès</label><input type="password" id="key" autocomplete="off">' + (ui.setupErr ? '<div class="err">' + esc(ui.setupErr) + '</div>' : '') +
      '<p><button class="btn pri block" data-a="setkey">Se connecter</button></p></div>';
  }
  function renderLogin() {
    const agents = Object.values(S().agents).filter(a => a.active !== false).sort((a, b) => C.natCmp(a.name, b.name));
    if (!agents.length) return '<div class="center"><h1>Éclairages de sécurité</h1><p>Aucun agent n\'existe encore. Créez le premier agent (nom et code PIN à 6 chiffres).</p><p><button class="btn pri block" data-a="newagent">Créer le premier agent</button></p><p><button class="btn block" data-a="syncnow">Actualiser</button></p><p class="mut">' + (eng.lastError ? 'Serveur injoignable pour le moment.' : '') + '</p></div>';
    return '<div class="center"><h1>Éclairages de sécurité</h1><label class="f">Agent</label><select id="lg-agent">' + agents.map(a => '<option value="' + esc(a.id) + '"' + (a.id === LS.get('baes.agent') ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select>' +
      '<label class="f">Code PIN (6 chiffres)</label><input class="pin" id="lg-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off">' + (ui.loginErr ? '<div class="err">' + esc(ui.loginErr) + '</div>' : '') +
      '<p><button class="btn pri block" data-a="login">Entrer</button></p><p><button class="btn block" data-a="newagent">Nouvel agent</button></p></div>';
  }
  function renderHome() {
    const s = S(), sel = ui.sel;
    if (sel.site && !s.sites[sel.site]) sel.site = ''; if (sel.building && !s.buildings[sel.building]) sel.building = ''; if (sel.floor && !s.floors[sel.floor]) sel.floor = '';
    const full = sel.site && sel.building && sel.floor;
    return top('Éclairages de sécurité') + '<main><div class="card"><label class="f" for="h-site">Site</label><select id="h-site" data-c="site">' + opts(C.sites(s), sel.site, '— Choisir un site —') + '</select>' +
      '<label class="f" for="h-b">Bâtiment</label><select id="h-b" data-c="building"' + (sel.site ? '' : ' disabled') + '>' + opts(sel.site ? C.buildingsOf(s, sel.site) : [], sel.building, '— Choisir un bâtiment —') + '</select>' +
      '<label class="f" for="h-f">Étage</label><select id="h-f" data-c="floor"' + (sel.building ? '' : ' disabled') + '>' + opts(sel.building ? C.floorsOf(s, sel.building) : [], sel.floor, '— Choisir un étage —') + '</select>' +
      (full ? '<p><button class="btn pri block" data-a="openfloor">Ouvrir l\'étage ›</button></p>' : '') + '</div>' +
      (Object.keys(s.sites).length ? '' : '<div class="warn">Aucun site pour le moment. Ouvrez « Gestion » pour créer vos sites, bâtiments et étages.</div>') +
      '<div class="menu"><button class="btn" data-a="nav" data-v="interventions">Interventions (' + openCount() + ')</button><button class="btn" data-a="nav" data-v="history">Historique et exports</button><button class="btn" data-a="nav" data-v="manage">Gestion</button><button class="btn" data-a="logout">Déconnexion<br><span class="mut">' + esc(session.name) + '</span></button></div></main>';
  }
  function renderFloor() {
    const s = S(), f = s.floors[ui.sel.floor], b = f && s.buildings[f.buildingId], si = b && s.sites[b.siteId];
    if (!f || f.del || !b || b.del || !si || si.del) { return top('Étage', true) + '<main><div class="warn">Cet étage n\'existe plus.</div></main>'; }
    const c = cur(); c.tab = c.tab || 'lights';
    let body;
    if (c.tab === 'lights') {
      const lights = C.lightsOf(s, f.id), cnt = { green: 0, orange: 0, red: 0 };
      const cells = lights.map(l => {
        const st = C.status(s, l); cnt[st.color]++;
        const pending = !C.remoteOfLight(s, l);
        return '<button class="cell ' + st.color + '" data-a="cell" data-id="' + l.id + '" aria-label="Éclairage ' + esc(l.number) + ', ' + esc(stLabel(st)) + (pending ? ', télécommande en attente d\'affectation' : '') + '">' + esc(l.number) +
          (st.color === 'red' ? '<span class="m">!</span>' : '') + (pending ? '<span class="p"></span>' : '') + (st.color !== 'green' && st.due ? '<span class="d">' + (st.color === 'orange' ? (st.overdue ? 'en retard' : 'à faire') : 'échu') + '</span>' : '') + '</button>';
      }).join('');
      body = '<div class="chips"><span class="chip green">' + cnt.green + ' conformes</span><span class="chip orange">' + cnt.orange + ' à contrôler</span><span class="chip red">' + cnt.red + ' anomalies</span></div>' +
        (lights.length ? '<div class="grid">' + cells + '</div>' : '<div class="warn">Aucun éclairage sur cet étage. Ajoutez-les avec le bouton ci-dessous.</div>') +
        '<p class="mut">! anomalie en cours · « à faire » / « en retard » : contrôle annuel · « échu » : anomalie dont l\'échéance annuelle est aussi dépassée · point blanc : télécommande en attente d\'affectation</p>' +
        '<div class="row"><button class="btn pri" data-a="validatefloor"' + (lights.length ? '' : ' disabled') + '>Tout valider sauf les rouges</button></div>' +
        '<div class="row" style="margin-top:8px"><button class="btn" data-a="addlight">+ Éclairage / série</button></div>';
    } else {
      const rs = C.remotesOf(s, si.id);
      body = (rs.length ? '<div class="card list">' + rs.map(r => {
        const st = C.status(s, r), n = C.lightsOfRemote(s, r.id).length;
        return '<button class="item" data-a="open-remote" data-id="' + r.id + '"><b>Télécommande n° ' + esc(r.number) + ' <span class="badge ' + st.color + '">' + esc(stLabel(st)) + '</span></b><span class="mut">' + esc([r.typeName, r.ref, r.place].filter(Boolean).join(' · ')) + ' — ' + plural(n, 'éclairage', 'éclairages') + '</span></button>';
      }).join('') + '</div>' : '<div class="warn">Aucune télécommande sur ce site.</div>') + '<p class="mut">Les télécommandes appartiennent au site « ' + esc(si.name) + ' », pas à un étage.</p><button class="btn pri block" data-a="addremote">+ Télécommande</button>';
    }
    return top(si.name + ' › ' + b.name + ' › ' + f.name, true) + '<div class="tabs"><button data-a="tab" data-v="lights" class="' + (c.tab === 'lights' ? 'on' : '') + '">Éclairages</button><button data-a="tab" data-v="remotes" class="' + (c.tab === 'remotes' ? 'on' : '') + '">Télécommandes</button></div><main>' + body + '</main>';
  }
  function anomList(e, kind) {
    const s = S(), list = C.openAnoms(s, e.id);
    if (!list.length) return '';
    return '<div class="card"><h2>Anomalies en cours</h2>' + list.map(a => '<div class="kv" style="align-items:center"><span style="color:var(--ink)"><b>' + esc(C.anomLabel(a)) + '</b><br><span class="mut">Déclarée le ' + fmt(a.declaredDay) + ' par ' + esc(a.declaredBy || '?') + '</span></span><button class="btn pri sm fit" data-a="done" data-id="' + a.id + '">Action réalisée</button></div>').join('') + '</div>';
  }
  function histList(e) {
    const h = (S().history[e.id] || []).slice().reverse();
    return '<div class="card"><h2>Historique</h2>' + (h.length ? h.map(x => '<div class="hist"><b>' + fmt(x.day) + ' ' + fmtTime(x.ts) + '</b> · ' + esc(x.agent) + '<br>' + esc(x.text) + '</div>').join('') : '<span class="mut">Aucun événement.</span>') + '</div>';
  }
  const origAttr = v => ' value="' + esc(v == null ? '' : v) + '" data-orig="' + esc(v == null ? '' : v) + '"';
  function renderLight() {
    const s = S(), l = s.lights[cur().id];
    if (!l || l.del) return top('Éclairage', true) + '<main><div class="warn">Cet éclairage n\'existe plus.</div></main>';
    const st = C.status(s, l), remote = C.remoteOfLight(s, l), remotes = C.remotesOf(s, (chainOf(l).site || {}).id);
    return top('Éclairage n° ' + l.number, true) + '<main><div class="card">' + badge(st) + '<div class="kv"><span>Emplacement</span><span>' + esc(chainText(l)) + '</span></div>' +
      '<div class="kv"><span>Échéance annuelle</span><span>' + fmt(st.next) + (st.overdue ? ' (dépassée)' : '') + '</span></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn pri" data-a="control"' + (st.open ? ' disabled' : '') + '>Contrôler</button><button class="btn" data-a="declare">Déclarer une anomalie</button></div>' + (st.open ? '<p class="mut">Un éclairage avec anomalie ne peut être contrôlé qu\'après « Action réalisée ».</p>' : '') + '</div>' +
      anomList(l, 'light') +
      '<div class="card"><h2>Fiche</h2><label class="f">Numéro physique (saisi à la main)</label><input type="text" id="f-number"' + origAttr(l.number) + '>' +
      '<label class="f">Type d\'équipement</label><input type="text" id="f-typeName" list="dl-types"' + origAttr(l.typeName) + '><datalist id="dl-types">' + typeNames('light').map(t => '<option value="' + esc(t) + '">').join('') + '</datalist>' +
      '<label class="f">Référence du matériel</label><input type="text" id="f-ref"' + origAttr(l.ref) + '>' +
      '<label class="f">Télécommande associée</label><select id="f-remoteId" data-orig="' + esc(remote ? remote.id : '') + '"><option value="">En attente d\'affectation de télécommande</option>' + remotes.map(r => '<option value="' + r.id + '"' + (remote && remote.id === r.id ? ' selected' : '') + '>Télécommande n° ' + esc(r.number) + (r.typeName ? ' — ' + esc(r.typeName) : '') + '</option>').join('') + '</select>' +
      '<label class="f">Observations</label><textarea id="f-obs" data-orig="' + esc(l.obs || '') + '">' + esc(l.obs || '') + '</textarea>' +
      '<div class="kv"><span>Date de remplacement</span><span>' + fmt(l.replacedAt) + '</span></div><div class="kv"><span>Dernier contrôle</span><span>' + fmt(l.lastControl) + '</span></div><div class="kv"><span>Prochain contrôle</span><span>' + fmt(st.next) + '</span></div>' +
      '<p><button class="btn pri block" data-a="saveequip">Enregistrer la fiche</button></p><p class="row"><button class="btn" data-a="replace">Remplacer l\'équipement</button><button class="btn danger" data-a="delequip">Supprimer</button></p></div>' + histList(l) + '</main>';
  }
  function renderRemote() {
    const s = S(), r = s.remotes[cur().id];
    if (!r || r.del) return top('Télécommande', true) + '<main><div class="warn">Cette télécommande n\'existe plus.</div></main>';
    const st = C.status(s, r), lights = C.lightsOfRemote(s, r.id).sort((a, b) => C.natCmp(a.number, b.number));
    return top('Télécommande n° ' + r.number, true) + '<main><div class="card">' + badge(st) + '<div class="kv"><span>Site</span><span>' + esc(siteName(r.siteId)) + '</span></div><div class="kv"><span>Échéance annuelle</span><span>' + fmt(st.next) + (st.overdue ? ' (dépassée)' : '') + '</span></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn pri" data-a="control"' + (st.open ? ' disabled' : '') + '>Contrôler</button><button class="btn" data-a="declare">Déclarer une anomalie</button></div><p class="mut">L\'état d\'une télécommande est indépendant de celui des éclairages associés.</p></div>' +
      anomList(r, 'remote') +
      '<div class="card"><h2>Fiche</h2><label class="f">Numéro</label><input type="text" id="f-number"' + origAttr(r.number) + '>' +
      '<label class="f">Emplacement dans le site</label><input type="text" id="f-place"' + origAttr(r.place) + '>' +
      '<label class="f">Type</label><input type="text" id="f-typeName" list="dl-types"' + origAttr(r.typeName) + '><datalist id="dl-types">' + typeNames('remote').map(t => '<option value="' + esc(t) + '">').join('') + '</datalist>' +
      '<label class="f">Référence</label><input type="text" id="f-ref"' + origAttr(r.ref) + '>' +
      '<label class="f">Observations</label><textarea id="f-obs" data-orig="' + esc(r.obs || '') + '">' + esc(r.obs || '') + '</textarea>' +
      '<div class="kv"><span>Date de remplacement</span><span>' + fmt(r.replacedAt) + '</span></div><div class="kv"><span>Dernier contrôle</span><span>' + fmt(r.lastControl) + '</span></div><div class="kv"><span>Prochain contrôle</span><span>' + fmt(st.next) + '</span></div>' +
      '<p><button class="btn pri block" data-a="saveequip">Enregistrer la fiche</button></p><p class="row"><button class="btn" data-a="replace">Remplacer l\'équipement</button><button class="btn danger" data-a="delequip">Supprimer</button></p></div>' +
      '<div class="card"><h2>Éclairages associés (' + lights.length + ')</h2>' + (lights.length ? '<div class="list">' + lights.map(l => '<button class="item" data-a="open-light" data-id="' + l.id + '"><b>n° ' + esc(l.number) + '</b><span class="mut">' + esc(chainText(l)) + '</span></button>').join('') + '</div>' : '<span class="mut">Aucun. L\'association se fait depuis la fiche de chaque éclairage.</span>') + '</div>' + histList(r) + '</main>';
  }
  function renderInterv() {
    const c = cur(); c.site = c.site || '';
    const rows = interventions(c.site);
    return top('Interventions à réaliser', true) + '<main><div class="card"><label class="f">Site</label><select data-c="iv-site">' + opts(C.sites(S()), c.site, 'Tous les sites') + '</select></div>' +
      '<p class="mut">' + plural(rows.length, 'anomalie à traiter', 'anomalies à traiter') + ' — les plus anciennes d\'abord</p>' +
      (rows.length ? '<div class="card list">' + rows.map(r => '<div class="item"><button style="all:unset;display:block;width:100%" data-a="' + (r.kind === 'light' ? 'open-light' : 'open-remote') + '" data-id="' + r.e.id + '"><b>' + esc(r.site) + (r.kind === 'light' ? ' › ' + esc(r.building) + ' › ' + esc(r.floor) + ' › éclairage n° ' + esc(r.num) : ' › télécommande n° ' + esc(r.num)) + '</b>' +
        '<span>' + esc(C.anomLabel(r.a)) + '</span><br><span class="mut">Déclarée le ' + fmt(r.a.declaredDay) + ' par ' + esc(r.a.declaredBy || '?') + '</span></button><div style="margin-top:8px"><button class="btn pri sm" data-a="done" data-id="' + r.a.id + '">Action réalisée</button></div></div>').join('') + '</div>' : '<div class="warn" style="background:#e5f6ec;border-color:#9fd7b4;color:#10351f">Aucune intervention en attente.</div>') + '</main>';
  }

  /* ----- historique et exports ----- */
  function histFilters() { const c = cur(); c.f = c.f || { site: '', building: '', floor: '', q: '', agent: '', from: '', to: '' }; return c.f; }
  function historyRows(f) {
    const s = S(), rows = [];
    const q = (f.q || '').toLowerCase();
    Object.keys(s.history).forEach(id => {
      const e = C.equipOf(s, id); if (!e || e.del) return;
      let site, building = '', floor = '', kind;
      if (s.lights[id]) { const c = chainOf(e); if (!c.site || c.site.del || !c.building || c.building.del || !c.floor || c.floor.del) return; site = c.site; building = c.building; floor = c.floor; kind = 'Éclairage'; }
      else { site = s.sites[e.siteId]; if (!site || site.del) return; kind = 'Télécommande'; if (f.building || f.floor) return; }
      if (f.site && site.id !== f.site) return; if (f.building && building.id !== f.building) return; if (f.floor && floor.id !== f.floor) return;
      if (q && ![e.number, e.typeName, e.ref].some(x => String(x || '').toLowerCase().includes(q))) return;
      s.history[id].forEach(h => {
        if (f.agent && h.agent !== f.agent) return; if (f.from && h.day < f.from) return; if (f.to && h.day > f.to) return;
        rows.push({ ts: h.ts, day: h.day, site: site.name, building: building.name || '', floor: floor.name || '', kind, num: e.number, type: e.typeName || '', text: h.text, agent: h.agent });
      });
    });
    return rows.sort((a, b) => b.ts.localeCompare(a.ts));
  }
  function renderHistory() {
    const s = S(), f = histFilters(), rows = historyRows(f);
    const agents = Object.values(s.agents).map(a => a.name).sort(C.natCmp);
    return top('Historique et exports', true) + '<main><div class="card"><h2>Filtres</h2><label class="f">Site</label><select data-c="hf-site">' + opts(C.sites(s), f.site, 'Tous les sites') + '</select>' +
      '<label class="f">Bâtiment</label><select data-c="hf-building"' + (f.site ? '' : ' disabled') + '>' + opts(f.site ? C.buildingsOf(s, f.site) : [], f.building, 'Tous les bâtiments') + '</select>' +
      '<label class="f">Étage</label><select data-c="hf-floor"' + (f.building ? '' : ' disabled') + '>' + opts(f.building ? C.floorsOf(s, f.building) : [], f.floor, 'Tous les étages') + '</select>' +
      '<label class="f">Équipement (n°, type ou référence)</label><input type="search" data-c="hf-q" value="' + esc(f.q) + '">' +
      '<label class="f">Agent</label><select data-c="hf-agent"><option value="">Tous les agents</option>' + agents.map(a => '<option' + (a === f.agent ? ' selected' : '') + '>' + esc(a) + '</option>').join('') + '</select>' +
      '<div class="row"><div><label class="f">Du</label><input type="date" data-c="hf-from" value="' + esc(f.from) + '"></div><div><label class="f">Au</label><input type="date" data-c="hf-to" value="' + esc(f.to) + '"></div></div>' +
      '<div class="row" style="margin-top:12px"><button class="btn pri" data-a="export-xlsx">Excel</button><button class="btn pri" data-a="export-pdf">PDF</button></div><p class="mut">Les exports reprennent ces filtres (site, bâtiment, étage, période) et incluent l\'inventaire, les interventions en cours et l\'historique.</p></div>' +
      '<p class="mut">' + plural(rows.length, 'événement', 'événements') + (rows.length > 150 ? ' (150 plus récents affichés)' : '') + '</p><div class="card">' +
      (rows.slice(0, 150).map(r => '<div class="hist"><b>' + fmt(r.day) + ' ' + fmtTime(r.ts) + '</b> · ' + esc(r.agent) + '<br>' + esc(r.site + (r.building ? ' › ' + r.building + ' › ' + r.floor : '') + ' › ' + r.kind.toLowerCase() + ' n° ' + r.num) + '<br>' + esc(r.text) + '</div>').join('') || '<span class="mut">Aucun événement pour ces filtres.</span>') + '</div></main>';
  }
  function buildExport(f) {
    const dx = d => d ? fmt(d) : '', s = S(), today = C.today(), st = (e) => C.status(s, e, today);
    const stText = x => x.open ? 'Anomalie en cours' : x.never ? 'Jamais contrôlé' : x.overdue ? 'Contrôle en retard' : x.due ? 'Contrôle à effectuer' : 'Conforme';
    const hist = historyRows(f);
    const invLights = [], invRemotes = [], counts = { green: 0, orange: 0, red: 0 };
    C.sites(s).filter(si => !f.site || si.id === f.site).forEach(si => {
      C.buildingsOf(s, si.id).filter(b => !f.building || b.id === f.building).forEach(b => C.floorsOf(s, b.id).filter(fl => !f.floor || fl.id === f.floor).forEach(fl => C.lightsOf(s, fl.id).forEach(l => {
        const x = st(l), r = C.remoteOfLight(s, l); counts[x.color]++;
        invLights.push([si.name, b.name, fl.name, l.number, l.typeName || '', l.ref || '', dx(l.replacedAt), dx(l.lastControl), dx(x.next), stText(x), C.openAnoms(s, l.id).map(C.anomLabel).join(' ; '), r ? 'n° ' + r.number : 'En attente d\'affectation', l.obs || '']);
      })));
      if (!f.building && !f.floor) C.remotesOf(s, si.id).forEach(r => { const x = st(r); invRemotes.push([si.name, r.number, r.place || '', r.typeName || '', r.ref || '', dx(r.replacedAt), dx(r.lastControl), dx(x.next), stText(x), C.openAnoms(s, r.id).map(C.anomLabel).join(' ; '), C.lightsOfRemote(s, r.id).length, r.obs || '']); });
    });
    const iv = interventions('').filter(r => (!f.site || r.site === siteName(f.site)) && (!f.building || (S().buildings[f.building] || {}).name === r.building) && (!f.floor || (S().floors[f.floor] || {}).name === r.floor) && !(r.kind === 'remote' && (f.building || f.floor)));
    const ivRows = iv.map(r => [r.site, r.building, r.floor, r.kind === 'light' ? 'Éclairage' : 'Télécommande', r.num, C.anomLabel(r.a), dx(r.a.declaredDay), r.a.declaredBy || '']);
    const histRows = hist.map(r => [dx(r.day), fmtTime(r.ts), r.site, r.building, r.floor, r.kind, r.num, r.text, r.agent]);
    const desc = [f.site ? 'Site : ' + siteName(f.site) : 'Tous les sites', f.building ? 'Bâtiment : ' + (s.buildings[f.building] || {}).name : '', f.floor ? 'Étage : ' + (s.floors[f.floor] || {}).name : '', (f.from || f.to) ? 'Période : ' + (f.from ? dx(f.from) : '…') + ' → ' + (f.to ? dx(f.to) : '…') : 'Toute la période', f.agent ? 'Agent : ' + f.agent : '', f.q ? 'Équipement : ' + f.q : ''].filter(Boolean);
    return { desc, counts, invLights, invRemotes, ivRows, histRows, today };
  }
  function download(name, bytes, type) { const b = new Blob([bytes], { type }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000); }
  function doExport(kind) {
    const x = buildExport(histFilters()), name = 'eclairages-securite-' + x.today;
    if (kind === 'xlsx') {
      download(name + '.xlsx', Exporter.xlsx([
        { name: 'Historique', rows: [['Date', 'Heure', 'Site', 'Bâtiment', 'Étage', 'Équipement', 'N°', 'Événement', 'Agent']].concat(x.histRows) },
        { name: 'Éclairages', rows: [['Site', 'Bâtiment', 'Étage', 'N°', 'Type', 'Référence', 'Date de remplacement', 'Dernier contrôle', 'Prochain contrôle', 'État', 'Anomalies en cours', 'Télécommande', 'Observations']].concat(x.invLights) },
        { name: 'Télécommandes', rows: [['Site', 'N°', 'Emplacement', 'Type', 'Référence', 'Date de remplacement', 'Dernier contrôle', 'Prochain contrôle', 'État', 'Anomalies en cours', 'Éclairages associés', 'Observations']].concat(x.invRemotes) },
        { name: 'Interventions en cours', rows: [['Site', 'Bâtiment', 'Étage', 'Équipement', 'N°', 'Nature', 'Déclarée le', 'Par']].concat(x.ivRows) }]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } else {
      const tot = x.counts.green + x.counts.orange + x.counts.red;
      download(name + '.pdf', Exporter.pdf({
        title: 'Bilan des éclairages de sécurité', lines: x.desc.concat(['Édité le ' + fmt(x.today) + ' par ' + session.name]),
        sections: [
          { heading: 'Synthèse des éclairages', cols: [{ h: 'État', w: 3 }, { h: 'Nombre', w: 1 }], rows: [['Conformes', x.counts.green], ['Contrôle annuel à effectuer ou en retard', x.counts.orange], ['Anomalie ou maintenance en cours', x.counts.red], ['Total', tot]] },
          { heading: 'Interventions en cours', cols: [{ h: 'Site', w: 2 }, { h: 'Bâtiment', w: 2 }, { h: 'Étage', w: 1.5 }, { h: 'Équipement', w: 1.5 }, { h: 'N°', w: .8 }, { h: 'Nature', w: 4 }, { h: 'Déclarée le', w: 1.4 }, { h: 'Par', w: 1.5 }], rows: x.ivRows },
          { heading: 'Historique des contrôles et interventions', note: 'Les événements antérieurs à un remplacement d\'équipement ne sont pas conservés.', cols: [{ h: 'Date', w: 1.2 }, { h: 'Heure', w: .8 }, { h: 'Site', w: 2 }, { h: 'Bâtiment', w: 2 }, { h: 'Étage', w: 1.3 }, { h: 'Équip.', w: 1.4 }, { h: 'N°', w: .8 }, { h: 'Événement', w: 5 }, { h: 'Agent', w: 1.4 }], rows: x.histRows }] }), 'application/pdf');
    }
    toast('Export prêt');
  }

  /* ----- gestion ----- */
  function renderManage() {
    const s = S(), g = cur(); g.site = g.site && s.sites[g.site] && !s.sites[g.site].del ? g.site : ''; g.building = g.building && s.buildings[g.building] && !s.buildings[g.building].del && s.buildings[g.building].siteId === g.site ? g.building : '';
    const row = (k, o, extra) => '<div class="kv" style="align-items:center"><span style="color:var(--ink)">' + esc(o.name) + '</span><span class="row" style="flex:0 0 auto;gap:4px">' + (extra || '') + '<button class="btn sm" data-a="mg-rename" data-k="' + k + '" data-id="' + o.id + '">Renommer</button><button class="btn sm danger" data-a="mg-del" data-k="' + k + '" data-id="' + o.id + '">Suppr.</button></span></div>';
    const bs = g.site ? C.buildingsOf(s, g.site) : [], fs = g.building ? C.floorsOf(s, g.building) : [];
    const agents = Object.values(s.agents).sort((a, b) => C.natCmp(a.name, b.name));
    return top('Gestion', true) + '<main><div class="card"><h2>Sites</h2>' + (C.sites(s).map(o => row('site', o)).join('') || '<span class="mut">Aucun site.</span>') + '<p><button class="btn block" data-a="mg-add" data-k="site">+ Ajouter des sites</button></p></div>' +
      '<div class="card"><h2>Bâtiments et étages</h2><label class="f">Site</label><select data-c="mg-site">' + opts(C.sites(s), g.site, '— Choisir un site —') + '</select>' +
      (g.site ? '<h2 style="margin-top:14px">Bâtiments</h2>' + (bs.map(o => row('building', o, '<button class="btn sm" data-a="mg-pick" data-id="' + o.id + '">Étages</button>')).join('') || '<span class="mut">Aucun bâtiment.</span>') + '<p><button class="btn block" data-a="mg-add" data-k="building">+ Ajouter des bâtiments</button></p>' : '') +
      (g.building ? '<h2 style="margin-top:14px">Étages de « ' + esc(s.buildings[g.building].name) + ' »</h2>' + (fs.map((o, i) => row('floor', o, '<button class="btn sm" data-a="mg-up" data-id="' + o.id + '"' + (i ? '' : ' disabled') + ' aria-label="Monter">↑</button><button class="btn sm" data-a="mg-down" data-id="' + o.id + '"' + (i < fs.length - 1 ? '' : ' disabled') + ' aria-label="Descendre">↓</button>')).join('') || '<span class="mut">Aucun étage.</span>') + '<p><button class="btn block" data-a="mg-add" data-k="floor">+ Ajouter des étages</button></p>' : '') + '</div>' +
      '<div class="card"><h2>Catalogue des types de matériel</h2><p class="mut"><b>Éclairages :</b> ' + esc(typeNames('light').join(', ') || 'aucun') + '<br><b>Télécommandes :</b> ' + esc(typeNames('remote').join(', ') || 'aucun') + '</p><div class="row"><button class="btn" data-a="mg-type" data-k="light">+ Type d\'éclairage</button><button class="btn" data-a="mg-type" data-k="remote">+ Type de télécommande</button></div></div>' +
      '<div class="card"><h2>Agents</h2>' + agents.map(a => '<div class="kv" style="align-items:center"><span style="color:var(--ink)">' + esc(a.name) + (a.active === false ? ' <span class="mut">(désactivé)</span>' : '') + '</span><button class="btn sm" data-a="mg-agent-toggle" data-id="' + a.id + '">' + (a.active === false ? 'Réactiver' : 'Désactiver') + '</button></div>').join('') + '<p><button class="btn block" data-a="newagent">+ Nouvel agent</button></p></div></main>';
  }

  function render() {
    dirty = false;
    const scroll = window.scrollY;
    let html;
    if (!LS.get('baes.key') && eng.cursor === 0 && !eng.confirmed.length) html = renderSetup();
    else if (!session) html = renderLogin();
    else { const sc = cur().s; html = ({ home: renderHome, floor: renderFloor, light: renderLight, remote: renderRemote, interventions: renderInterv, history: renderHistory, manage: renderManage }[sc] || renderHome)(); }
    $app.innerHTML = html;
    if (cur().s === ui.lastScreen) window.scrollTo(0, scroll); ui.lastScreen = cur().s;
  }

  /* ---------- actions ---------- */
  const equipId = () => cur().id;
  async function pickType(cat, name) { if (name && !typeNames(cat).some(t => t.toLowerCase() === name.toLowerCase())) await push('type.add', { id: C.uid(), cat, name }); }

  async function declareFlow(id) {
    const e = C.equipOf(S(), id), kind = S().lights[id] ? 'light' : 'remote';
    const r = await modal({ title: (kind === 'light' ? 'Éclairage n° ' : 'Télécommande n° ') + e.number + ' — anomalies', ok: 'Déclarer', fields: [{ type: 'checks', id: 'codes', options: kind === 'light' ? C.ANOM_LIGHT : C.ANOM_REMOTE }, { id: 'comment', label: 'Commentaire (obligatoire pour « Autre anomalie »)' }],
      validate: (b, v) => !v.codes.length ? 'Cochez au moins une anomalie.' : v.codes.includes('autre') && !v.comment ? 'Précisez l\'autre anomalie dans le commentaire.' : '' });
    if (!r) return;
    await push('anom.add', { equipId: id, kind, gen: e.gen, items: r.v.codes.map(c => ({ id: C.uid(), code: c, comment: c === 'autre' ? r.v.comment : '' })) });
    toast(plural(r.v.codes.length, 'anomalie déclarée', 'anomalies déclarées')); render();
  }
  async function quickMenu(id) {
    const s = S(), l = s.lights[id]; if (!l) return; const st = C.status(s, l);
    const r = await modal({ title: 'Éclairage n° ' + l.number, intro: '<div>' + badge(st) + '<div class="mut" style="margin-top:6px">Échéance annuelle : ' + fmt(st.next) + (st.overdue ? ' (dépassée)' : '') + (st.open ? ' · ' + plural(st.open, 'anomalie en cours', 'anomalies en cours') : '') + '</div></div>',
      fields: [{ type: 'checks', id: 'codes', label: 'Déclarer une anomalie', options: C.ANOM_LIGHT }, { id: 'comment', label: 'Commentaire (obligatoire pour « Autre anomalie »)' }],
      buttons: [{ id: 'declare', label: 'Déclarer', cls: 'pri' }, { id: 'control', label: 'Contrôler' }, { id: 'fiche', label: 'Ouvrir la fiche' }],
      validate: (b, v) => b === 'control' && st.open ? 'Une anomalie est en cours : validez d\'abord « Action réalisée ».' : b === 'declare' ? (!v.codes.length ? 'Cochez au moins une anomalie.' : v.codes.includes('autre') && !v.comment ? 'Précisez l\'autre anomalie dans le commentaire.' : '') : '' });
    if (!r) return;
    if (r.btn === 'fiche') return go('light', { id });
    if (r.btn === 'control') { await push('ctl.add', { equipId: id, gen: l.gen }); toast('Éclairage n° ' + l.number + ' contrôlé'); return render(); }
    await push('anom.add', { equipId: id, kind: 'light', gen: l.gen, items: r.v.codes.map(c => ({ id: C.uid(), code: c, comment: c === 'autre' ? r.v.comment : '' })) });
    toast('Éclairage n° ' + l.number + ' : anomalie déclarée'); render();
  }
  async function validateFloor() {
    const s = S(), lights = C.lightsOf(s, ui.sel.floor), ok = lights.filter(l => C.status(s, l).color !== 'red'), red = lights.length - ok.length;
    if (!ok.length) return toast('Aucun éclairage à valider : tous présentent une anomalie.');
    const r = await modal({ title: 'Validation de l\'étage', ok: 'Confirmer', autofocus: false,
      intro: '<p><b>' + (ok.length > 1 ? ok.length + ' éclairages vont être enregistrés comme contrôlés' : '1 éclairage va être enregistré comme contrôlé') + '. Confirmer ?</b></p><p class="mut">' + (red ? plural(red, 'éclairage rouge reste', 'éclairages rouges restent') + ' en attente de maintenance. ' : 'Aucun éclairage rouge sur cet étage. ') + 'Contrôle enregistré au nom de ' + esc(session.name) + ' le ' + fmt(C.today()) + '.</p>' });
    if (!r) return;
    await push('ctl.bulk', { floorId: ui.sel.floor, ids: ok.map(l => ({ id: l.id, gen: l.gen })) });
    toast(plural(ok.length, 'éclairage contrôlé', 'éclairages contrôlés')); render();
  }
  async function addLights() {
    const s = S(), f = s.floors[ui.sel.floor], site = chainOf({ floorId: f.id }).site;
    const remotes = C.remotesOf(s, site.id);
    const r = await modal({ title: 'Ajouter des éclairages', ok: 'Ajouter', autofocus: true, fields: [
      { id: 'number', label: 'Numéro physique (ou premier numéro d\'une série)', inputmode: 'text' }, { id: 'to', label: 'Dernier numéro de la série (facultatif, nombres entiers)', type: 'number' },
      { id: 'typeName', label: 'Type d\'équipement', list: typeNames('light') }, { id: 'ref', label: 'Référence (pour un seul éclairage ; à compléter individuellement pour une série)' },
      { id: 'remoteId', label: 'Télécommande', type: 'select', options: [{ v: '', l: 'En attente d\'affectation de télécommande' }].concat(remotes.map(x => ({ v: x.id, l: 'Télécommande n° ' + x.number }))) },
      { id: 'replacedAt', label: 'Date de remplacement (facultatif)', type: 'date' }, { id: 'lastControl', label: 'Dernier contrôle connu (facultatif)', type: 'date' }],
    validate: (b, v) => { if (!v.number) return 'Indiquez le numéro physique.'; if (v.to) { const a = +v.number, z = +v.to; if (!/^\d+$/.test(v.number) || !/^\d+$/.test(v.to) || z < a) return 'Une série va d\'un entier à un entier plus grand ou égal.'; if (z - a >= 200) return '200 éclairages maximum à la fois.'; } return ''; } });
    if (!r) return; const v = r.v;
    const numbers = v.to ? Array.from({ length: +v.to - +v.number + 1 }, (_, i) => String(+v.number + i)) : [v.number];
    const have = new Set(C.lightsOf(s, f.id).map(l => String(l.number))), todo = numbers.filter(n => !have.has(n));
    await pickType('light', v.typeName);
    quiet = true;
    try { for (const n of todo) await push('ent.set', { kind: 'light', id: C.uid(), f: { floorId: f.id, number: n, typeName: v.typeName, ref: numbers.length === 1 ? v.ref : '', remoteId: v.remoteId || null, replacedAt: v.replacedAt || '', lastControl: v.lastControl || v.replacedAt || '', obs: '' } }); } finally { quiet = false; }
    toast(plural(todo.length, 'éclairage ajouté', 'éclairages ajoutés') + (todo.length < numbers.length ? ' (' + (numbers.length - todo.length) + ' numéro(s) déjà existant(s) ignoré(s))' : '')); render();
  }
  async function addRemote() {
    const s = S(), f = s.floors[ui.sel.floor], site = chainOf({ floorId: f.id }).site;
    const r = await modal({ title: 'Ajouter une télécommande', ok: 'Ajouter', autofocus: true, fields: [{ id: 'number', label: 'Numéro' }, { id: 'place', label: 'Emplacement dans le site (libre)' }, { id: 'typeName', label: 'Type', list: typeNames('remote') }, { id: 'ref', label: 'Référence' }, { id: 'replacedAt', label: 'Date de remplacement (facultatif)', type: 'date' }, { id: 'lastControl', label: 'Dernier contrôle connu (facultatif)', type: 'date' }],
      validate: (b, v) => !v.number ? 'Indiquez le numéro.' : C.remotesOf(s, site.id).some(x => String(x.number) === v.number) ? 'Ce numéro existe déjà sur ce site.' : '' });
    if (!r) return; const v = r.v;
    await pickType('remote', v.typeName);
    await push('ent.set', { kind: 'remote', id: C.uid(), f: { siteId: site.id, number: v.number, place: v.place, typeName: v.typeName, ref: v.ref, replacedAt: v.replacedAt, lastControl: v.lastControl || v.replacedAt || '', obs: '' } });
    toast('Télécommande ajoutée'); render();
  }
  async function saveEquip() {
    const id = equipId(), e = C.equipOf(S(), id), isLight = !!S().lights[id], fields = {};
    $app.querySelectorAll('[id^="f-"]').forEach(el => { const k = el.id.slice(2); if (el.value.trim() !== (el.dataset.orig || '')) fields[k] = el.value.trim(); });
    if (fields.remoteId === '') fields.remoteId = null;
    if (!Object.keys(fields).length) return toast('Aucune modification');
    if ('number' in fields && !fields.number) return toast('Le numéro ne peut pas être vide.');
    if (isLight && fields.number && C.lightsOf(S(), e.floorId).some(x => x.id !== id && String(x.number) === fields.number) && !confirm('Un autre éclairage porte déjà le numéro ' + fields.number + ' sur cet étage. Enregistrer quand même ?')) return;
    if (!isLight && fields.number && C.remotesOf(S(), e.siteId).some(x => x.id !== id && String(x.number) === fields.number) && !confirm('Une autre télécommande porte déjà ce numéro sur ce site. Enregistrer quand même ?')) return;
    if (fields.typeName) await pickType(isLight ? 'light' : 'remote', fields.typeName);
    await push('ent.set', { kind: isLight ? 'light' : 'remote', id, f: fields });
    toast('Fiche enregistrée'); render();
  }
  async function replaceFlow() {
    const id = equipId(), e = C.equipOf(S(), id), isLight = !!S().lights[id];
    const r = await modal({ title: 'Remplacer ' + (isLight ? 'l\'éclairage n° ' : 'la télécommande n° ') + e.number, ok: 'Remplacer', autofocus: true,
      intro: '<div class="warn"><b>Remise à zéro complète.</b> Les anomalies, interventions et l\'historique actuels seront supprimés définitivement. Le numéro est conservé' + (isLight ? '.' : ', ainsi que les éclairages associés.') + ' Le remplacement vaut contrôle : prochain contrôle dans un an.</div>',
      fields: [{ id: 'typeName', label: 'Nouveau type', value: e.typeName || '', list: typeNames(isLight ? 'light' : 'remote') }, { id: 'ref', label: 'Nouvelle référence' }, { id: 'replacedAt', label: 'Date de remplacement', type: 'date', value: C.today() }],
      validate: (b, v) => !v.typeName ? 'Indiquez le type.' : !v.ref ? 'Indiquez la référence.' : !v.replacedAt ? 'Indiquez la date.' : v.replacedAt > C.today() ? 'La date ne peut pas être dans le futur.' : '' });
    if (!r) return;
    await pickType(isLight ? 'light' : 'remote', r.v.typeName);
    await push('equip.replace', { equipId: id, gen: e.gen, f: { typeName: r.v.typeName, ref: r.v.ref, replacedAt: r.v.replacedAt } });
    toast('Équipement remplacé, suivi remis à zéro'); render();
  }
  async function agentFlow(first) {
    const r = await modal({ title: 'Nouvel agent', ok: 'Créer', autofocus: true, fields: [{ id: 'name', label: 'Nom' }, { id: 'pin', label: 'Code PIN à 6 chiffres', type: 'password', inputmode: 'numeric', maxlength: 6, cls: 'pin' }],
      validate: (b, v) => !v.name ? 'Indiquez le nom.' : !/^\d{6}$/.test(v.pin) ? 'Le PIN doit comporter exactement 6 chiffres.' : Object.values(S().agents).some(a => a.name.toLowerCase() === v.name.toLowerCase() && a.active !== false) ? 'Un agent porte déjà ce nom.' : '' });
    if (!r) return; const id = C.uid();
    await push('agent.add', { id, name: r.v.name, pinHash: C.hashPin(id, r.v.pin) });
    toast('Agent créé'); render();
  }

  const actions = {
    back() { history.back(); },
    nav(el) { go(el.dataset.v); },
    tab(el) { cur().tab = el.dataset.v; render(); },
    openfloor() { go('floor'); },
    'open-light'(el) { go('light', { id: el.dataset.id }); },
    'open-remote'(el) { go('remote', { id: el.dataset.id }); },
    cell(el) { return quickMenu(el.dataset.id); },
    validatefloor: validateFloor, addlight: addLights, addremote: addRemote, saveequip: saveEquip, replace: replaceFlow, declare() { return declareFlow(equipId()); },
    newagent() { return agentFlow(); },
    async control() { const e = C.equipOf(S(), equipId()); await push('ctl.add', { equipId: e.id, gen: e.gen }); toast('Contrôle enregistré'); render(); },
    async done(el) {
      const a = S().anomalies[el.dataset.id]; if (!a) return;
      if (!confirm('Confirmer : « ' + C.anomLabel(a) + ' » est réalisée ?\nCela vaut aussi contrôle de l\'équipement.')) return;
      await push('anom.done', { id: a.id }); toast('Action enregistrée'); render();
    },
    async delequip() {
      const e = C.equipOf(S(), equipId()), isLight = !!S().lights[e.id];
      if (!confirm('Supprimer ' + (isLight ? 'l\'éclairage n° ' : 'la télécommande n° ') + e.number + ' ?' + (!isLight && C.lightsOfRemote(S(), e.id).length ? '\n' + plural(C.lightsOfRemote(S(), e.id).length, 'éclairage repassera', 'éclairages repasseront') + ' « en attente d\'affectation ».' : ''))) return;
      await push('ent.del', { kind: isLight ? 'light' : 'remote', id: e.id }); history.back(); toast('Supprimé');
    },
    'export-xlsx'() { doExport('xlsx'); }, 'export-pdf'() { doExport('pdf'); },
    logout() { session = null; LS.del('baes.agent'); ui.stack = [{ s: 'home' }]; ui.loginErr = ''; render(); },
    async syncnow() { await eng.sync(); if (eng.lastError && eng.lastError.code === 401) { LS.del('baes.key'); ui.setupErr = 'Clé d\'accès refusée par le serveur.'; } toast(eng.lastError ? (eng.lastError.code === 401 ? 'Clé refusée' : 'Serveur injoignable — vos données restent enregistrées sur ce téléphone') : 'Synchronisé'); render(); },
    async setkey() {
      const k = document.getElementById('key').value.trim(); if (!k) return;
      const u = document.getElementById('srv').value.trim(); if (u && !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:|\/))/i.test(u)) { ui.setupErr = 'L\'adresse du serveur doit commencer par https://'; return render(); }
      LS.set('baes.server', u); LS.set('baes.key', k); ui.setupErr = ''; await eng.sync();
      if (eng.lastError) { ui.setupErr = eng.lastError.code === 401 ? 'Clé d\'accès incorrecte.' : 'Serveur injoignable ou adresse incorrecte. Vérifiez l\'adresse et la connexion, puis réessayez.'; if (eng.lastError.code === 401) LS.del('baes.key'); }
      render();
    },
    login() {
      const id = document.getElementById('lg-agent').value, pin = document.getElementById('lg-pin').value, a = S().agents[id];
      if (a && /^\d{6}$/.test(pin) && C.hashPin(id, pin) === a.pinHash) { session = { id, name: a.name }; LS.set('baes.agent', id); ui.loginErr = ''; ui.stack = [{ s: 'home' }]; history.replaceState({ d: 1 }, ''); render(); eng.sync(); }
      else { ui.loginErr = 'PIN incorrect.'; render(); }
    },
    /* gestion */
    'mg-pick'(el) { cur().building = el.dataset.id; render(); },
    async 'mg-add'(el) {
      const k = el.dataset.k, g = cur(), label = { site: 'sites', building: 'bâtiments', floor: 'étages' }[k];
      const r = await modal({ title: 'Ajouter des ' + label, ok: 'Ajouter', autofocus: true, fields: [{ id: 'names', label: 'Noms, séparés par des virgules' + (k === 'floor' ? ' (ex. : Sous-sol, RDC, 1, 2)' : '') }], validate: (b, v) => v.names ? '' : 'Indiquez au moins un nom.' });
      if (!r) return; const names = r.v.names.split(',').map(x => x.trim()).filter(Boolean);
      const parent = k === 'building' ? { siteId: g.site } : k === 'floor' ? { buildingId: g.building } : {};
      let order = k === 'floor' ? Math.max(-1, ...C.floorsOf(S(), g.building).map(x => x.order ?? 0)) + 1 : 0;
      quiet = true; try { for (const n of names) await push('ent.set', { kind: k, id: C.uid(), f: Object.assign({ name: n }, parent, k === 'floor' ? { order: order++ } : {}) }); } finally { quiet = false; }
      toast(plural(names.length, 'ajouté', 'ajoutés')); render();
    },
    async 'mg-rename'(el) {
      const k = el.dataset.k, o = S()[C.COL[k]][el.dataset.id];
      const r = await modal({ title: 'Renommer', ok: 'Enregistrer', autofocus: true, fields: [{ id: 'name', label: 'Nom', value: o.name }], validate: (b, v) => v.name ? '' : 'Indiquez un nom.' });
      if (r && r.v.name !== o.name) { await push('ent.set', { kind: k, id: o.id, f: { name: r.v.name } }); render(); }
    },
    async 'mg-del'(el) {
      const k = el.dataset.k, id = el.dataset.id, s = S(); let n = 0;
      if (k === 'site') n = Object.values(s.lights).filter(l => !l.del && (chainOf(l).site || {}).id === id).length + C.remotesOf(s, id).length;
      if (k === 'building') n = Object.values(s.lights).filter(l => !l.del && (chainOf(l).building || {}).id === id).length;
      if (k === 'floor') n = C.lightsOf(s, id).length;
      if (!confirm('Supprimer « ' + s[C.COL[k]][id].name + ' » ?' + (n ? '\n' + plural(n, 'équipement n\'apparaîtra', 'équipements n\'apparaîtront') + ' plus dans l\'application.' : ''))) return;
      await push('ent.del', { kind: k, id }); render();
    },
    async 'mg-up'(el) { return moveFloor(el.dataset.id, -1); }, async 'mg-down'(el) { return moveFloor(el.dataset.id, 1); },
    async 'mg-type'(el) {
      const cat = el.dataset.k, r = await modal({ title: cat === 'light' ? 'Nouveau type d\'éclairage' : 'Nouveau type de télécommande', ok: 'Ajouter', autofocus: true, fields: [{ id: 'name', label: 'Libellé' }], validate: (b, v) => v.name ? '' : 'Indiquez un libellé.' });
      if (r) { await pickType(cat, r.v.name); render(); }
    },
    async 'mg-agent-toggle'(el) { const a = S().agents[el.dataset.id]; if (a.id === session.id && a.active !== false) return toast('Vous ne pouvez pas désactiver votre propre agent.'); await push('agent.update', { id: a.id, f: { active: a.active === false } }); render(); },
  };
  async function moveFloor(id, dir) {
    const f = S().floors[id], arr = C.floorsOf(S(), f.buildingId), i = arr.findIndex(x => x.id === id), j = i + dir; if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    quiet = true; try { for (let k = 0; k < arr.length; k++) if (arr[k].order !== k) await push('ent.set', { kind: 'floor', id: arr[k].id, f: { order: k } }); } finally { quiet = false; }
    render();
  }

  $app.addEventListener('click', e => {
    const el = e.target.closest('[data-a]'); if (!el || el.disabled) return;
    const fn = actions[el.dataset.a]; if (!fn) return;
    Promise.resolve(fn(el)).catch(err => { console.error(err); toast('Erreur : ' + (err && err.message || err)); });
  });
  $app.addEventListener('change', e => {
    const t = e.target, c = t.dataset && t.dataset.c; if (!c) return; const s = ui.sel;
    if (c === 'site') { s.site = t.value; s.building = ''; s.floor = ''; saveSel(); render(); }
    else if (c === 'building') { s.building = t.value; s.floor = ''; saveSel(); render(); }
    else if (c === 'floor') { s.floor = t.value; saveSel(); if (t.value) go('floor'); else render(); }
    else if (c === 'iv-site') { cur().site = t.value; render(); }
    else if (c === 'mg-site') { cur().site = t.value; cur().building = ''; render(); }
    else if (c.startsWith('hf-')) { const f = histFilters(), k = c.slice(3); f[k] = t.value; if (k === 'site') { f.building = ''; f.floor = ''; } if (k === 'building') f.floor = ''; render(); }
  });
  $app.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'lg-pin') actions.login(); if (e.key === 'Enter' && e.target.id === 'key') actions.setkey(); });

  /* ---------- démarrage ---------- */
  (async function boot() {
    try { eng = new Eng(idbStore(), net, () => session); await eng.init(); }
    catch (e) { $app.innerHTML = '<div class="center"><h1>Stockage indisponible</h1><p>Ce navigateur refuse le stockage local nécessaire au mode hors connexion (navigation privée ?). Ouvrez l\'application dans un onglet normal.</p></div>'; return; }
    eng.on(requestRender);
    const saved = LS.get('baes.agent'); // le téléphone retient le dernier agent, mais le PIN reste demandé à chaque ouverture
    render();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* HTTPS requis hors localhost */ });
    if (LS.get('baes.key')) eng.sync();
    window.addEventListener('online', () => LS.get('baes.key') && eng.sync());
    document.addEventListener('visibilitychange', () => { if (!document.hidden && LS.get('baes.key')) eng.sync(); });
    setInterval(() => { if (session && !document.hidden && LS.get('baes.key') && navigator.onLine !== false) eng.sync(); }, 60000); // + à chaque retour sur l'application et 1 s après chaque action
    window.__baes = { eng, C, get session() { return session; } };
  })();
})();
