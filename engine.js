/* Moteur local-first : stockage local, file d'attente, synchronisation.
   Indépendant du navigateur : le stockage et le réseau sont injectés (utile pour les tests). */
(function (root) {
  'use strict';
  const Core = typeof require !== 'undefined' ? require('./core.js') : root.Core;

  function Engine(store, net, agentRef) {
    this.store = store; this.net = net; this.agentRef = agentRef || (() => null);
    this.confirmed = []; this.pending = []; this.cursor = 0;
    this.state = Core.newState(); this.listeners = []; this.syncing = false; this.again = false;
    this.lastSync = null; this.lastError = null;
  }
  Engine.prototype.on = function (fn) { this.listeners.push(fn); };
  Engine.prototype.emit = function () { this.listeners.forEach(f => f()); };
  Engine.prototype.init = async function () {
    const all = await this.store.loadAll();
    this.confirmed = all.confirmed.sort((a, b) => a.seq - b.seq); this.pending = all.pending.sort((a, b) => a.n - b.n);
    this.cursor = all.cursor || 0; this.lastSync = all.lastSync || null;
    this.rebuild();
  };
  Engine.prototype.rebuild = function () {
    const s = Core.newState();
    this.confirmed.forEach(o => Core.apply(s, o)); this.pending.forEach(o => Core.apply(s, o));
    this.state = s;
  };
  /* Enregistre une action localement (immédiat, sans réseau) puis demande une synchro. */
  Engine.prototype.push = async function (type, d) {
    const ag = this.agentRef();
    const now = new Date();
    const op = { id: Core.uid(), n: (this.pending.length ? this.pending[this.pending.length - 1].n : 0) + 1 + Math.floor(Math.random() * 0),
      agent: ag ? { id: ag.id, name: ag.name } : null, ts: now.toISOString(), day: Core.today(now), type, d };
    this.pending.push(op);
    Core.apply(this.state, op);
    await this.store.addPending(op);
    this.emit();
    return op;
  };
  Engine.prototype.sync = async function () {
    if (this.syncing) { this.again = true; return; }
    this.syncing = true; this.lastError = null; this.emit();
    const acked = new Set(); let changed = false;
    try {
      for (let guard = 0; guard < 200; guard++) {
        const toSend = this.pending.filter(o => !acked.has(o.id)).slice(0, 300);
        const res = await this.net.sync(this.cursor, toSend.map(o => { const c = Object.assign({}, o); delete c.n; return c; }));
        (res.acked || []).forEach(i => acked.add(i));
        const fresh = res.ops.filter(o => o.seq > this.cursor);
        if (fresh.length) { this.confirmed.push(...fresh); this.cursor = fresh[fresh.length - 1].seq; changed = true; await this.store.addConfirmed(fresh, this.cursor); }
        if (!res.more && !this.pending.some(o => !acked.has(o.id))) break;
      }
      if (acked.size) { this.pending = this.pending.filter(o => !acked.has(o.id)); await this.store.removePending([...acked]); changed = true; }
      this.lastSync = new Date().toISOString(); await this.store.setMeta('lastSync', this.lastSync);
    } catch (e) { this.lastError = e; }
    this.syncing = false;
    if (changed) this.rebuild();
    this.emit();
    if (this.again) { this.again = false; return this.sync(); }
  };

  const api = { Engine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EngineLib = api;
})(typeof self !== 'undefined' ? self : this);
