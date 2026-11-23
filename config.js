// Optional settings for your copy of the game.
window.WHOAMI_CONFIG = {
  // Public address of the web player (e.g. "https://yourname.github.io/who-am-i/").
  // When set, the lobby shows "Copy invite link" so friends can join from a browser
  // without downloading anything. Leave empty to share codes only.
  webClientUrl: '',

  // Custom STUN/TURN servers. Leave null to use PeerJS defaults (Google STUN + PeerJS TURN).
  iceServers: null,
};
