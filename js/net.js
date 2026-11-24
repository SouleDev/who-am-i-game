// Networking. The host's browser/app *is* the server: it registers a PeerJS id derived from
// the lobby code, and players connect to it peer-to-peer over WebRTC. The free PeerJS cloud
// broker is only used to introduce peers; game traffic goes directly between players
// (or through PeerJS's public TURN relay when a direct connection isn't possible).
const PEER_PREFIX = 'whoami-party-v1-';

const Net = {
  peer: null,
  role: null,      // 'host' | 'client'
  host: null,      // HostGame (host only)
  conn: null,      // DataConnection to host (client only)
  myPid: null,
  onMessage: null, // set by UI
  onClosed: null,

  peerOptions() {
    const o = { debug: 1 };
    if (window.WHOAMI_CONFIG?.iceServers) o.config = { iceServers: window.WHOAMI_CONFIG.iceServers };
    return o;
  },

  // ---------------- host ----------------
  hostLobby() {
    return new Promise((resolve, reject) => {
      const tryCode = (attempt) => {
        const code = randomCode(6);
        const peer = new Peer(PEER_PREFIX + code, this.peerOptions());
        let opened = false;
        peer.on('open', () => {
          opened = true;
          this.peer = peer; this.role = 'host';
          this.host = new HostGame(code, msg => this.deliver(msg));
          const prof = Profile.get();
          const me = this.host.addPlayer({ clientId: Profile.clientId(), name: prof.name, known: prof.known, checked: prof.checked, dropped: prof.dropped, isHost: true });
          this.myPid = me.pid;
          this.host.feed = [];
          this.host.sys(`Lobby created. Share the code ${code} with your friends.`);
          this.host.changed();
          resolve(code);
        });
        peer.on('connection', conn => this.acceptConnection(conn));
        peer.on('disconnected', () => { if (this.peer === peer) setTimeout(() => !peer.destroyed && peer.reconnect(), 1500); });
        peer.on('error', err => {
          console.warn('peer error', err.type, err);
          if (!opened) {
            peer.destroy();
            if (err.type === 'unavailable-id' && attempt < 5) return tryCode(attempt + 1);
            reject(new Error(friendlyPeerError(err)));
          }
        });
      };
      tryCode(0);
    });
  },

  acceptConnection(conn) {
    let pid = null;
    conn.on('data', m => {
      if (!m || typeof m !== 'object') return;
      if (!pid) {
        if (m.t !== 'hello') return;
        const res = this.host.addPlayer({
          clientId: String(m.clientId || conn.peer).slice(0, 64), name: String(m.name || 'Player'),
          known: Array.isArray(m.known) ? m.known : [], checked: Array.isArray(m.checked) ? m.checked : [], dropped: Array.isArray(m.dropped) ? m.dropped : [], conn, have: Array.isArray(m.have) ? m.have : [],
        });
        if (res.error) { conn.send({ t: 'rejected', reason: res.error }); setTimeout(() => conn.close(), 500); return; }
        pid = res.pid;
        conn.send({ t: 'welcome', pid, code: this.host.code, fandoms: this.host.fandomCatalog() });
        this.host.changed();
        return;
      }
      this.host.handle(pid, m);
    });
    const gone = () => { if (pid && this.host?.player(pid)?.conn === conn) this.host.disconnect(pid); };
    conn.on('close', gone);
    conn.on('error', gone);
  },

  // ---------------- client ----------------
  joinLobby(code) {
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return new Promise((resolve, reject) => {
      const peer = new Peer(this.peerOptions());
      let settled = false;
      const fail = (msg) => { if (!settled) { settled = true; peer.destroy(); reject(new Error(msg)); } };
      const timer = setTimeout(() => fail('Could not reach that lobby. Check the code and that the host is still online.'), 20000);
      peer.on('open', () => {
        const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
        conn.on('open', () => {
          const prof = Profile.get();
          conn.send({ t: 'hello', clientId: Profile.clientId(), name: prof.name, known: prof.known, checked: prof.checked, dropped: prof.dropped });
        });
        conn.on('data', m => {
          if (m?.t === 'welcome') {
            clearTimeout(timer); settled = true;
            this.peer = peer; this.conn = conn; this.role = 'client'; this.myPid = m.pid;
            Library.rememberRemoteFandoms(m.fandoms || []);
            resolve(m);
            return;
          }
          if (m?.t === 'rejected') { clearTimeout(timer); return fail(m.reason || 'The host refused the connection.'); }
          if (settled && this.conn === conn) this.deliver(m);
        });
        conn.on('close', () => { if (this.conn === conn) { this.conn = null; this.onClosed?.('The connection to the host was lost.'); } });
      });
      peer.on('error', err => {
        console.warn('peer error', err.type, err);
        if (!settled) { clearTimeout(timer); fail(friendlyPeerError(err)); }
      });
    });
  },

  // ---------------- common ----------------
  send(msg) {
    if (this.role === 'host') queueMicrotask(() => this.host.handle(this.myPid, msg));
    else if (this.conn?.open) this.conn.send(msg);
  },

  deliver(msg) { this.onMessage?.(msg); },

  leave() {
    try { if (this.role === 'host' && this.host) for (const p of this.host.players) if (!p.isHost) p.conn?.send({ t: 'closed' }); } catch { }
    const peer = this.peer;
    setTimeout(() => { try { peer?.destroy(); } catch { } }, 200);
    clearTimeout(this.host?._timer);
    this.peer = null; this.conn = null; this.host = null; this.role = null; this.myPid = null;
  },
};

function friendlyPeerError(err) {
  switch (err?.type) {
    case 'peer-unavailable': return 'No lobby found with that code. Double-check it with the host.';
    case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
      return 'Could not reach the matchmaking server. Check your internet connection.';
    case 'browser-incompatible': return 'This browser does not support WebRTC.';
    default: return 'Connection problem: ' + (err?.message || err?.type || 'unknown error');
  }
}

window.addEventListener('beforeunload', () => { if (Net.role) Net.leave(); });
