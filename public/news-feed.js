/* ---------- Steamoji Staff Portal: News Feed (portal home, right column) ----------
   Staff read; the director posts. Director sign-in reuses the same director key
   (OWNER_KEY) and localStorage slot as the Issue Tracker, so signing in on either
   page signs you in on both.
*/
(function(){
  var OWNER_KEY = 'staffportal:ownerKey', READ_KEY = 'staffportal:newsRead';
  var NEW_WINDOW_MS = 14 * 24 * 3600 * 1000; // "New" badge only for unopened posts from the last 2 weeks
  var state = { posts: [], director: false, loaded: false };

  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k,v){ try{ if(v===null) localStorage.removeItem(k); else localStorage.setItem(k,v); }catch(e){} }
  function $(id){ return document.getElementById(id); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function linkify(s){
    return esc(s).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }
  function headers(){
    var h = { 'x-staff-key': (typeof getStaffKey === 'function' ? getStaffKey() : '') };
    var ok = lsGet(OWNER_KEY); if(ok) h['x-owner-key'] = ok;
    return h;
  }
  function readSet(){ try{ return JSON.parse(lsGet(READ_KEY) || '[]'); }catch(e){ return []; } }
  function markRead(id){ var r = readSet(); if(r.indexOf(id) < 0){ r.push(id); lsSet(READ_KEY, JSON.stringify(r.slice(-300))); } }
  function isNew(p){ return Date.now() - p.created_at < NEW_WINDOW_MS && readSet().indexOf(p.id) < 0; }

  var MONTH_FMT = new Intl.DateTimeFormat(undefined, { month:'long', year:'numeric' });
  var DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday:'short', month:'short', day:'numeric' });
  var TIME_FMT = new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit' });
  var FULL_FMT = new Intl.DateTimeFormat(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
  function dayKey(d){ return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function dayLabel(d){
    var t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
    if(dayKey(d) === dayKey(t)) return 'Today · ' + DAY_FMT.format(d);
    if(dayKey(d) === dayKey(y)) return 'Yesterday · ' + DAY_FMT.format(d);
    return DAY_FMT.format(d);
  }

  function toast(msg){
    var t = document.createElement('div'); t.className = 'nf-toast toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function(){ t.remove(); }, 2600);
  }

  /* ---------- feed list ---------- */
  function load(){
    fetch('/api/news', { headers: headers() }).then(function(r){
      return r.json().then(function(d){ return { ok:r.ok, d:d }; });
    }).then(function(x){
      if(!x.ok){ $('nfList').innerHTML = '<p class="nf-empty">' + esc(x.d.error || 'Could not load updates.') + '</p>'; return; }
      state.posts = x.d.posts || []; state.director = !!x.d.director; state.loaded = true;
      if(!state.director && lsGet(OWNER_KEY)) lsSet(OWNER_KEY, null); // stale key
      renderHead(); renderList(); openFromHash();
    }).catch(function(){ $('nfList').innerHTML = '<p class="nf-empty">Could not load updates. Check your connection.</p>'; });
  }

  function renderHead(){
    var a = $('nfDirector');
    a.innerHTML = state.director
      ? '<button class="nf-btn" id="nfNew">+ New update</button><button class="nf-link" id="nfOut" title="Sign out of director mode">Director ✓</button>'
      : '<button class="nf-link" id="nfIn">Director sign-in</button>';
    if($('nfNew')) $('nfNew').onclick = function(){ openComposer(null); };
    if($('nfOut')) $('nfOut').onclick = function(){ if(confirm('Sign out of director mode on this device?')){ lsSet(OWNER_KEY, null); state.director = false; renderHead(); renderList(); } };
    if($('nfIn')) $('nfIn').onclick = directorSignIn;
  }

  function directorSignIn(){
    var k = prompt('Director key (the OWNER_KEY set on the server):');
    if(!k) return;
    fetch('/api/issues/owner-check', { headers: { 'x-owner-key': k } }).then(function(r){
      if(r.ok){ lsSet(OWNER_KEY, k); state.director = true; renderHead(); renderList(); toast('Signed in as director'); }
      else if(r.status === 503){ alert('OWNER_KEY is not set on the server yet.'); }
      else { alert("That director key didn't match."); }
    });
  }

  function mediaBadge(p){
    var img = 0, vid = 0;
    (p.media || []).forEach(function(m){ if(m.kind === 'video') vid++; else img++; });
    var out = '';
    if(img) out += '<span class="nf-meta-chip" title="' + img + ' photo' + (img>1?'s':'') + '">▣ ' + img + '</span>';
    if(vid) out += '<span class="nf-meta-chip" title="' + vid + ' video' + (vid>1?'s':'') + '">▶ ' + vid + '</span>';
    return out;
  }

  function renderList(){
    var el = $('nfList');
    $('nfCount').textContent = state.posts.length ? state.posts.length + (state.posts.length === 1 ? ' update' : ' updates') : '';
    if(!state.posts.length){
      el.innerHTML = '<p class="nf-empty">No updates yet.' + (state.director ? ' Post the first one with “+ New update”.' : ' Check back soon.') + '</p>';
      return;
    }
    var html = '', lastMonth = '', lastDay = '';
    state.posts.forEach(function(p){
      var d = new Date(p.created_at), m = MONTH_FMT.format(d), dk = dayKey(d);
      if(m !== lastMonth){
        if(lastMonth) html += '</ul></section>';
        html += '<section class="nf-month"><h3 class="nf-month-h">' + esc(m) + '</h3><ul class="nf-items">';
        lastMonth = m; lastDay = '';
      }
      if(dk !== lastDay){ html += '<li class="nf-day">' + esc(dayLabel(d)) + '</li>'; lastDay = dk; }
      var thumb = (p.media || []).filter(function(x){ return x.kind === 'image'; })[0];
      html += '<li><button class="nf-item' + (isNew(p) ? ' is-new' : '') + '" data-id="' + p.id + '">' +
        (thumb ? '<img class="nf-thumb" src="/api/news/media/' + esc(thumb.file) + '" alt="" loading="lazy">' : '') +
        '<span class="nf-item-main"><span class="nf-title">' + esc(p.title) + '</span>' +
        '<span class="nf-sub">' + esc(TIME_FMT.format(d)) + mediaBadge(p) + (isNew(p) ? '<span class="nf-new">New</span>' : '') + '</span></span></button></li>';
    });
    html += '</ul></section>';
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll('.nf-item'), function(b){
      b.onclick = function(){ openPost(parseInt(b.getAttribute('data-id'), 10)); };
    });
  }

  /* ---------- overlay ---------- */
  var lastFocus = null;
  function showOverlay(html, cls){
    lastFocus = document.activeElement;
    var o = $('nfOverlay');
    o.className = 'nf-overlay open ' + (cls || '');
    $('nfPanel').innerHTML = '<button class="nf-close" id="nfClose" aria-label="Close">✕</button>' + html;
    $('nfClose').onclick = closeOverlay;
    document.body.classList.add('nf-noscroll');
    setTimeout(function(){ var f = $('nfPanel').querySelector('input,textarea,.nf-close'); if(f) f.focus(); }, 20);
  }
  function closeOverlay(){
    var o = $('nfOverlay');
    Array.prototype.forEach.call(o.querySelectorAll('video'), function(v){ try{ v.pause(); }catch(e){} });
    o.className = 'nf-overlay';
    $('nfPanel').innerHTML = '';
    document.body.classList.remove('nf-noscroll');
    if(location.hash.indexOf('#news-') === 0) history.replaceState(null, '', location.pathname + location.search);
    if(lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function mediaHtml(m){
    var src = '/api/news/media/' + esc(m.file);
    if(m.kind === 'video') return '<video class="nf-media" src="' + src + '" controls playsinline preload="metadata"></video>';
    return '<a href="' + src + '" target="_blank" rel="noopener" title="Open full size"><img class="nf-media" src="' + src + '" alt=""></a>';
  }

  function openPost(id){
    var p = state.posts.filter(function(x){ return x.id === id; })[0];
    if(!p) return;
    markRead(p.id);
    history.replaceState(null, '', '#news-' + p.id);
    var d = new Date(p.created_at);
    var edited = p.updated_at - p.created_at > 60000 ? ' · edited' : '';
    showOverlay(
      '<p class="nf-o-eyebrow">' + esc(FULL_FMT.format(d)) + edited + '</p>' +
      '<h2 class="nf-o-title" id="nfOTitle">' + esc(p.title) + '</h2>' +
      '<p class="nf-o-by">From ' + esc(p.author || 'Director') + '</p>' +
      (p.body ? '<div class="nf-o-body">' + linkify(p.body) + '</div>' : '') +
      ((p.media || []).length ? '<div class="nf-o-media">' + p.media.map(mediaHtml).join('') + '</div>' : '') +
      (state.director ? '<div class="nf-o-actions"><button class="nf-btn ghost" id="nfEdit">Edit</button><button class="nf-btn danger" id="nfDel">Delete</button></div>' : '')
    , 'read');
    $('nfPanel').setAttribute('aria-labelledby', 'nfOTitle');
    if($('nfEdit')) $('nfEdit').onclick = function(){ openComposer(p); };
    if($('nfDel')) $('nfDel').onclick = function(){
      if(!confirm('Delete “' + p.title + '”? This removes it for everyone and cannot be undone.')) return;
      fetch('/api/news/' + p.id, { method:'DELETE', headers: headers() }).then(function(r){ return r.json(); }).then(function(d){
        if(d.ok){ closeOverlay(); toast('Update deleted'); load(); } else alert(d.error || 'Delete failed');
      });
    };
    renderList();
  }

  function openFromHash(){
    var m = /^#news-(\d+)$/.exec(location.hash);
    if(m) openPost(parseInt(m[1], 10));
  }

  /* ---------- composer (director only) ---------- */
  function openComposer(post){
    var editing = !!post, picked = [], removeIds = [];
    showOverlay(
      '<p class="nf-o-eyebrow">' + (editing ? 'Edit update' : 'New update for staff') + '</p>' +
      '<h2 class="nf-o-title">' + (editing ? 'Edit update' : 'Post an update') + '</h2>' +
      '<label class="nf-f" for="nfT">Title</label>' +
      '<input id="nfT" maxlength="160" placeholder="e.g. New laser cutter safety checklist" value="' + (editing ? esc(post.title) : '') + '">' +
      '<label class="nf-f" for="nfB">Details</label>' +
      '<textarea id="nfB" maxlength="10000" rows="7" placeholder="What staff need to know. Links are clickable.">' + (editing ? esc(post.body) : '') + '</textarea>' +
      '<label class="nf-f">Images or videos <span class="nf-opt">(optional, up to 6, 200 MB each)</span></label>' +
      '<div class="nf-files" id="nfFiles"></div>' +
      '<label class="nf-drop" id="nfDrop"><input type="file" id="nfFile" accept="image/*,video/*" multiple hidden>＋ Add photo or video</label>' +
      '<div class="nf-progress" id="nfProg" hidden><span></span></div>' +
      '<div class="nf-o-actions"><button class="nf-btn" id="nfSave">' + (editing ? 'Save changes' : 'Post update') + '</button><button class="nf-btn ghost" id="nfCancel">Cancel</button><span class="nf-err" id="nfErr"></span></div>'
    , 'compose');

    function drawFiles(){
      var existing = editing ? post.media.filter(function(m){ return removeIds.indexOf(m.id) < 0; }) : [];
      var html = existing.map(function(m){
        var src = '/api/news/media/' + esc(m.file);
        return '<div class="nf-chip">' + (m.kind === 'video' ? '<video src="' + src + '" muted preload="metadata"></video><span class="nf-chip-tag">▶</span>' : '<img src="' + src + '" alt="">') +
          '<button type="button" data-rm-existing="' + m.id + '" aria-label="Remove">✕</button></div>';
      }).join('');
      html += picked.map(function(f, i){
        var url = URL.createObjectURL(f);
        return '<div class="nf-chip">' + (/^video\//.test(f.type) || /\.(mp4|mov|webm|m4v)$/i.test(f.name) ? '<video src="' + url + '" muted preload="metadata"></video><span class="nf-chip-tag">▶</span>' : '<img src="' + url + '" alt="">') +
          '<button type="button" data-rm-new="' + i + '" aria-label="Remove">✕</button></div>';
      }).join('');
      $('nfFiles').innerHTML = html;
      Array.prototype.forEach.call($('nfFiles').querySelectorAll('button'), function(b){
        b.onclick = function(){
          if(b.hasAttribute('data-rm-new')) picked.splice(parseInt(b.getAttribute('data-rm-new'), 10), 1);
          else removeIds.push(parseInt(b.getAttribute('data-rm-existing'), 10));
          drawFiles();
        };
      });
      var total = existing.length + picked.length;
      $('nfDrop').style.display = total >= 6 ? 'none' : '';
    }
    function addFiles(list){
      var err = $('nfErr'); err.textContent = '';
      Array.prototype.forEach.call(list, function(f){
        if(!/^(image|video)\//.test(f.type) && !/\.(jpe?g|png|webp|gif|heic|heif|mp4|mov|webm|m4v)$/i.test(f.name)){ err.textContent = f.name + ' is not an image or video.'; return; }
        if(f.size > 200 * 1024 * 1024){ err.textContent = f.name + ' is over 200 MB.'; return; }
        picked.push(f);
      });
      var existing = editing ? post.media.length - removeIds.length : 0;
      if(existing + picked.length > 6){ picked = picked.slice(0, 6 - existing); err.textContent = 'Max 6 files per update.'; }
      drawFiles();
    }
    $('nfFile').onchange = function(){ addFiles(this.files); this.value = ''; };
    var drop = $('nfDrop');
    drop.ondragover = function(e){ e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = function(){ drop.classList.remove('over'); };
    drop.ondrop = function(e){ e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
    $('nfCancel').onclick = function(){ if(editing) openPost(post.id); else closeOverlay(); };
    drawFiles();

    $('nfSave').onclick = function(){
      var title = $('nfT').value.trim(), body = $('nfB').value.trim(), err = $('nfErr');
      if(!title){ err.textContent = 'Add a title.'; $('nfT').focus(); return; }
      var fd = new FormData();
      fd.append('title', title); fd.append('body', body); fd.append('author', 'Director');
      if(editing && removeIds.length) fd.append('removeMedia', removeIds.join(','));
      picked.forEach(function(f){ fd.append('media', f, f.name); });
      var btn = $('nfSave'); btn.disabled = true; btn.textContent = editing ? 'Saving…' : 'Posting…'; err.textContent = '';
      var prog = $('nfProg'), bar = prog.querySelector('span');
      // XHR (not fetch) so a large video shows upload progress.
      var xhr = new XMLHttpRequest();
      xhr.open(editing ? 'PATCH' : 'POST', editing ? '/api/news/' + post.id : '/api/news');
      var h = headers(); Object.keys(h).forEach(function(k){ xhr.setRequestHeader(k, h[k]); });
      if(picked.length){
        prog.hidden = false;
        xhr.upload.onprogress = function(e){ if(e.lengthComputable) bar.style.width = Math.round(e.loaded / e.total * 100) + '%'; };
      }
      xhr.onload = function(){
        var d = {}; try{ d = JSON.parse(xhr.responseText); }catch(e){}
        if(xhr.status === 200 && d.ok){
          toast(editing ? 'Update saved' : 'Update posted');
          var openId = editing ? post.id : d.id;
          fetch('/api/news', { headers: headers() }).then(function(r){ return r.json(); }).then(function(x){
            state.posts = x.posts || []; renderList(); openPost(openId);
          });
        } else {
          btn.disabled = false; btn.textContent = editing ? 'Save changes' : 'Post update'; prog.hidden = true; bar.style.width = '0';
          err.textContent = d.error || ('Upload failed (' + xhr.status + ').');
        }
      };
      xhr.onerror = function(){ btn.disabled = false; btn.textContent = editing ? 'Save changes' : 'Post update'; prog.hidden = true; err.textContent = 'Network error. Try again.'; };
      xhr.send(fd);
    };
  }

  /* ---------- boot ---------- */
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && $('nfOverlay').classList.contains('open')){
      if($('nfOverlay').classList.contains('compose') && $('nfT') && ($('nfT').value || $('nfB').value) && !confirm('Discard this update?')) return;
      closeOverlay();
    }
  });
  document.addEventListener('DOMContentLoaded', function(){
    $('nfOverlay').addEventListener('click', function(e){ if(e.target === this && !this.classList.contains('compose')) closeOverlay(); });
    renderHead();
  });
  document.addEventListener('portal:unlocked', function(){ if($('nfList')) load(); });
})();
