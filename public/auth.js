/* ---------- Steamoji Staff Portal — shared passphrase gate (v1) ----------
   NOTE: This is a lightweight deterrent (keeps casual visitors/crawlers out),
   not real security. The hash below lives in this file's source, so a
   technically determined person could work around it. Don't rely on this to
   protect sensitive data. Planned to be replaced with real Google-account
   sign-in later — this is intentionally the simple v1.

   One passphrase, one shared login, for the whole portal: unlocking on the
   portal landing page also unlocks every project under it (Free-Time Idea
   Engine, and whatever gets added later), since they all check the same
   localStorage key.

   To change the passphrase: compute SHA-256 of the new passphrase and
   replace AUTH_HASH below. In any browser console:
   crypto.subtle.digest('SHA-256', new TextEncoder().encode('your passphrase')).then(b=>console.log(Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')))
*/
const AUTH_HASH = "7a44363b0feda50d6ea2e38a8803ae2473d55a8ef74b79cb87303abee0b5987e"; // SHA-256 of the staff passphrase (the passphrase itself is not stored in this file)
const AUTH_STORAGE_KEY = 'staffportal:auth';

async function sha256Hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function unlockApp(){
  document.body.classList.remove('locked');
  try{ document.dispatchEvent(new Event('portal:unlocked')); }catch(e){}
}
/* Pages that call the server (e.g. Issue Tracker) send this as x-staff-key. */
function getStaffKey(){
  try{ return localStorage.getItem(AUTH_STORAGE_KEY) || sessionStorage.getItem(AUTH_STORAGE_KEY) || ''; }catch(e){ return ''; }
}
function lockApp(){
  document.body.classList.add('locked');
  const pw = document.getElementById('authPassword');
  if(pw){ pw.value = ''; pw.focus(); }
}

function checkRememberedAuth(){
  try{
    if(localStorage.getItem(AUTH_STORAGE_KEY) === AUTH_HASH){ unlockApp(); }
  }catch(e){ /* not remembered yet, or storage unavailable */ }
}

async function attemptLogin(){
  const pwInput = document.getElementById('authPassword');
  const errEl = document.getElementById('authError');
  const remember = document.getElementById('authRemember');
  if(!pwInput || !pwInput.value){ return; }
  const hash = await sha256Hex(pwInput.value);
  if(hash === AUTH_HASH){
    if(errEl) errEl.style.display = 'none';
    try{ sessionStorage.setItem(AUTH_STORAGE_KEY, AUTH_HASH); }catch(e){}
    unlockApp();
    if(remember && remember.checked){
      try{ localStorage.setItem(AUTH_STORAGE_KEY, AUTH_HASH); }catch(e){}
    }
  } else {
    if(errEl) errEl.style.display = 'block';
    pwInput.value = '';
    pwInput.focus();
  }
}

function initAuthGate(){
  const submitBtn = document.getElementById('authSubmit');
  const pwInput = document.getElementById('authPassword');
  const lockLink = document.getElementById('lockLink');
  if(submitBtn) submitBtn.addEventListener('click', attemptLogin);
  if(pwInput) pwInput.addEventListener('keydown', e=>{ if(e.key==='Enter') attemptLogin(); });
  if(lockLink) lockLink.addEventListener('click', ()=>{
    try{ localStorage.removeItem(AUTH_STORAGE_KEY); sessionStorage.removeItem(AUTH_STORAGE_KEY); }catch(e){}
    lockApp();
  });
  checkRememberedAuth();
}

document.addEventListener('DOMContentLoaded', initAuthGate);

/* ---------- Director mode (one sign-in for the whole portal) ----------
   The director key is the OWNER_KEY set on the server. Signing in here turns on
   director features on every page: Issue Tracker status changes, Supply Requests
   director actions, and News Feed posting. Pages read it with
   PortalDirector.isOn() / PortalDirector.key() and re-render on the
   'portal:director' event (event.detail.director = true/false).

   The control sits in the page header next to the Lock link. Any page with
   #lockLink gets it automatically; no per-page sign-in code is needed.
*/
(function(){
  var KEY = 'staffportal:ownerKey'; // same slot the tools used before, so existing sign-ins carry over
  function get(){ try{ return localStorage.getItem(KEY) || ''; }catch(e){ return ''; } }
  function set(v){ try{ if(v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); }catch(e){} }
  function announce(){
    render();
    try{ document.dispatchEvent(new CustomEvent('portal:director', { detail: { director: !!get() } })); }catch(e){}
  }

  var STYLE =
    '.pd-area{display:inline-flex;align-items:center;gap:10px;font-family:"IBM Plex Mono",monospace;font-size:11.5px;letter-spacing:0;text-transform:none;}' +
    '.eyebrow .pd-area{margin-left:auto;}' +
    '.eyebrow .pd-area + .lock-link{margin-left:14px;}' +
    '.pd-link{background:none;border:none;padding:0;cursor:pointer;font:inherit;color:var(--ink-muted,#5B6F8A);}' +
    '.pd-link:hover{color:var(--cyan,#1769C9);text-decoration:underline;}' +
    '.pd-badge{color:#1F5FBF;border:1px solid #1F5FBF;background:rgba(31,95,191,.07);padding:2px 9px;border-radius:20px;font-weight:600;}' +
    '.pd-gate{position:fixed;inset:0;z-index:2000;display:none;align-items:center;justify-content:center;background:rgba(11,42,85,.45);padding:20px;}' +
    '.pd-gate.open{display:flex;}' +
    '.pd-card{width:100%;max-width:360px;background:#fff;border:1px solid #D6E3F2;border-radius:2px;padding:26px 24px;box-shadow:0 20px 50px rgba(11,42,85,.25);font-family:Inter,system-ui,sans-serif;color:#172B45;}' +
    '.pd-card .pd-eyebrow{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#1769C9;margin:0 0 8px;}' +
    '.pd-card h2{margin:0 0 8px;font-size:20px;color:#0B2A55;}' +
    '.pd-card p{margin:0 0 18px;font-size:13px;line-height:1.5;color:#5B6F8A;}' +
    '.pd-card input{width:100%;box-sizing:border-box;border:1px solid #A9C1E0;border-radius:2px;padding:11px 12px;font-size:14px;margin-bottom:12px;font-family:inherit;}' +
    '.pd-card input:focus-visible{outline:2px solid #1769C9;outline-offset:1px;}' +
    '.pd-row{display:flex;gap:10px;}' +
    '.pd-go{flex:1;background:#1F5FBF;color:#fff;border:none;font-weight:700;font-size:14px;padding:11px;border-radius:2px;cursor:pointer;font-family:"Space Grotesk",sans-serif;}' +
    '.pd-go:hover{background:#174EA0;} .pd-go:disabled{opacity:.6;cursor:wait;}' +
    '.pd-cancel{background:none;border:1px solid #A9C1E0;color:#1F5FBF;font-weight:600;font-size:14px;padding:11px 14px;border-radius:2px;cursor:pointer;}' +
    '.pd-err{display:none;color:#CB3732;font-family:"IBM Plex Mono",monospace;font-size:11.5px;margin-top:12px;padding:9px 11px;border:1px solid rgba(203,55,50,.4);background:rgba(203,55,50,.08);border-radius:2px;}';

  function ensureStyle(){
    if(document.getElementById('pdStyle')) return;
    var st = document.createElement('style'); st.id = 'pdStyle'; st.textContent = STYLE; document.head.appendChild(st);
  }
  function ensureUi(){
    ensureStyle();
    if(document.getElementById('pdGate')) return;
    var g = document.createElement('div'); g.className = 'pd-gate'; g.id = 'pdGate';
    g.innerHTML = '<div class="pd-card" role="dialog" aria-modal="true" aria-labelledby="pdTitle">' +
      '<p class="pd-eyebrow">Steamoji Staff Portal</p><h2 id="pdTitle">Director sign-in</h2>' +
      '<p>Turns on director features across the portal: issue status, supply request actions and news posting.</p>' +
      '<input type="password" id="pdKey" placeholder="Director key" autocomplete="off">' +
      '<div class="pd-row"><button class="pd-go" id="pdGo">Sign in</button><button class="pd-cancel" id="pdCancel">Cancel</button></div>' +
      '<div class="pd-err" id="pdErr"></div></div>';
    document.body.appendChild(g);
    document.getElementById('pdGo').onclick = submit;
    document.getElementById('pdCancel').onclick = close;
    document.getElementById('pdKey').addEventListener('keydown', function(e){ if(e.key === 'Enter') submit(); if(e.key === 'Escape') close(); });
    g.addEventListener('click', function(e){ if(e.target === g) close(); });
  }
  function open(){
    ensureUi();
    var g = document.getElementById('pdGate'), k = document.getElementById('pdKey');
    document.getElementById('pdErr').style.display = 'none'; k.value = '';
    g.classList.add('open'); setTimeout(function(){ k.focus(); }, 20);
  }
  function close(){ var g = document.getElementById('pdGate'); if(g) g.classList.remove('open'); }
  function showErr(msg){ var e = document.getElementById('pdErr'); e.textContent = msg; e.style.display = 'block'; }
  function check(k){
    return fetch('/api/director/check', { headers: { 'x-owner-key': k } }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(d){ return { status: r.status, d: d }; });
    });
  }
  function submit(){
    var k = document.getElementById('pdKey').value.trim(), btn = document.getElementById('pdGo');
    if(!k) return;
    btn.disabled = true;
    check(k).then(function(x){
      btn.disabled = false;
      if(x.status === 200){ set(k); close(); announce(); }
      else if(x.status === 503){ showErr('Director sign-in is not set up on the server yet (OWNER_KEY missing).'); }
      else { showErr("That director key didn't match. Try again."); document.getElementById('pdKey').select(); }
    }).catch(function(){ btn.disabled = false; showErr('Could not reach the server. Check your connection.'); });
  }
  function signOut(){ set(''); announce(); }

  function render(){
    ensureStyle();
    var a = document.getElementById('directorArea');
    if(!a){
      var lock = document.getElementById('lockLink');
      if(!lock) return;
      a = document.createElement('span'); a.id = 'directorArea';
      lock.parentNode.insertBefore(a, lock);
    }
    a.className = 'pd-area';
    a.innerHTML = get()
      ? '<span class="pd-badge" title="Director features are on across the portal">Director</span><button class="pd-link" id="pdOut" type="button">Sign out</button>'
      : '<button class="pd-link" id="pdIn" type="button">Director sign-in</button>';
    var i = document.getElementById('pdIn'), o = document.getElementById('pdOut');
    if(i) i.onclick = open;
    if(o) o.onclick = function(){ if(confirm('Sign out of director mode on this device?')) signOut(); };
  }

  window.PortalDirector = {
    isOn: function(){ return !!get(); },
    key: get,
    signIn: open,
    signOut: signOut,
  };

  document.addEventListener('DOMContentLoaded', function(){
    render();
    // Locking the portal also ends director mode on this device.
    var lock = document.getElementById('lockLink');
    if(lock) lock.addEventListener('click', function(){ if(get()){ set(''); announce(); } });
    // If the server key was changed, drop the stale one quietly.
    var k = get();
    if(k) check(k).then(function(x){ if(x.status === 401){ set(''); announce(); } }).catch(function(){});
  });
})();
