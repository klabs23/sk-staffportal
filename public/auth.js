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
const AUTH_HASH = "3592ac3416f659269818298d6a97ca756d44c5cb02ff0bc3d2f585430e99d481"; // passphrase: OjiKirk2026
const AUTH_STORAGE_KEY = 'staffportal:auth';

async function sha256Hex(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function unlockApp(){
  document.body.classList.remove('locked');
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
    try{ localStorage.removeItem(AUTH_STORAGE_KEY); }catch(e){}
    lockApp();
  });
  checkRememberedAuth();
}

document.addEventListener('DOMContentLoaded', initAuthGate);
