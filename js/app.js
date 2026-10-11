/* دفتر يوميات GitHub Pages — PAT + كلمة سر تشفّر كل البيانات (حفظ محلي دائم) */
const $ = (id) => document.getElementById(id);
const LS = localStorage;
// بيانات الدخول (المالك + الريبو + الفرع + PAT + كلمة سر التشفير) في localStorage الدائم
// بطلب صريح من المالك ليبقى الدخول بعد إغلاق المتصفح — على جهازك الخاص فقط.
const SS = localStorage;

// كل بيانات الدخول محفوظة محلياً بشكل دائم (لا تُمسح بإغلاق المتصفح، فقط بزر خروج). لا شيء آخر يُخزن.
const S = { owner: 'gj_s_owner', repo: 'gj_s_repo', branch: 'gj_s_branch', token: 'gj_s_token', pwd: 'gj_s_pwd' };

let MEM = { entries: [], sha: null, blobs: new Map(), pending: [], calCursor: new Date(), filterDate: '', key: null, saltB64: null, loaded: false };

// الرفع لا يستمر بعد إغلاق المتصفح (لا شيء يعمل بعد موت الصفحة) — لذا:
// 1) نحذّر من إغلاق/تحديث التبويب أثناء الرفع. 2) إعادة الحفظ تُكمل من حيث توقفت (تتخطى المرفوع).
let uploading = false;
window.addEventListener('beforeunload', (e) => {
  if (uploading) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- أدوات ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function status(el, msg, isErr) { el.textContent = msg; el.style.color = isErr ? '#b3261e' : ''; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function ctx() {
  return {
    owner: (SS.getItem(S.owner) || '').trim(),
    repo: (SS.getItem(S.repo) || '').trim(),
    branch: (SS.getItem(S.branch) || 'main').trim() || 'main',
    token: SS.getItem(S.token) || '',
    pwd: SS.getItem(S.pwd) || '',
  };
}
function setConn(ok) {
  $('conn-dot').className = ok ? 'ok' : '';
  $('conn-text').textContent = ok ? 'متصل بـ GitHub' : 'غير متصل';
}

// ---------- سياسة الذاكرة ----------
// - المرفوعات: تُزال من الذاكرة فور نجاح الحفظ (المصغّرات تكفي، والكامل يُحمّل عند الطلب).
// - المحمّلة (المفتوحة للعرض): تُحذف تلقائياً بعد 24 ساعة — لا لحظياً ولا للأبد.
// - كل شيء في RAM فقط أصلاً: لا كتابة على القرص إطلاقاً، ويُمسح كله بإغلاق التبويب/الخروج.
const DAY_MS = 24 * 3600 * 1000;
function cacheBlob(key, url) { MEM.blobs.set(key, url); (MEM.blobAt = MEM.blobAt || new Map()).set(key, Date.now()); }
function getBlob(key) {
  const at = MEM.blobAt && MEM.blobAt.get(key);
  if (at && (Date.now() - at > DAY_MS)) { dropBlob(key); return undefined; }
  return MEM.blobs.get(key);
}
function dropBlob(key) {
  const u = MEM.blobs.get(key);
  if (typeof u === 'string') { try { URL.revokeObjectURL(u); } catch {} }
  MEM.blobs.delete(key);
  if (MEM.blobAt) MEM.blobAt.delete(key);
}
function sweepBlobs() {
  let n = 0;
  const now = Date.now();
  if (MEM.blobAt) {
    for (const [k, at] of [...MEM.blobAt]) {
      if (k === '__rec') continue;
      if (now - at > DAY_MS) { dropBlob(k); n++; }
    }
  }
  if (MEM.zipCache && MEM.zipAt) {
    for (const [k, at] of [...MEM.zipAt]) {
      if (now - at > DAY_MS) { MEM.zipCache.delete(k); MEM.zipAt.delete(k); if (MEM.zipJobs) delete MEM.zipJobs[k]; n++; }
    }
  }
  return n;
}
setInterval(() => {
  try {
    if (sweepBlobs() > 0 && !$('screen-app').classList.contains('hidden') && ctx().token) renderAll();
  } catch {}
}, 15 * 60 * 1000);

// ---------- الثيم (الوحيد المسموح محلياً) ----------
function initTheme() {
  const t = LS.getItem('gj_theme') || 'light';
  document.documentElement.dataset.theme = t;
  $('btn-theme').textContent = t === 'dark' ? '☀️' : '🌙';
}
$('btn-theme').onclick = () => {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = cur;
  LS.setItem('gj_theme', cur);
  $('btn-theme').textContent = cur === 'dark' ? '☀️' : '🌙';
};

// زر تثبيت PWA (يظهر فقط عندما يقرر المتصفح أن التطبيق قابل للتثبيت)
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const b = $('btn-install');
  if (b) b.classList.remove('hidden');
});
{
  const bi = $('btn-install');
  if (bi) bi.onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch {}
    deferredPrompt = null;
    bi.classList.add('hidden');
  };
}

// ---------- الدخول: PAT بصلاحية كتابة على ريبو محدد ----------
async function validateWritePat(owner, repo, token) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (res.status === 401) throw new Error('PAT غير صالح أو منتهي (401)');
  if (res.status === 403) throw new Error('ممنوع (403) — تحقق من الصلاحيات أو حد المعدل');
  if (res.status === 404) throw new Error('الريبو غير موجود أو هذا الـ PAT لا يصل إليه (404)');
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const j = await res.json();
  if (j.permissions && j.permissions.push !== true) {
    throw new Error('هذا الـ PAT للقراءة فقط — يلزم صلاحية كتابة (Contents: Read and write)');
  }
  return true;
}

function showLogin() {
  $('screen-login').classList.remove('hidden');
  $('screen-app').classList.add('hidden');
  $('btn-logout').classList.add('hidden');
  setConn(false);
}

function showApp() {
  $('screen-login').classList.add('hidden');
  $('screen-app').classList.remove('hidden');
  $('btn-logout').classList.remove('hidden');
  const c = ctx();
  $('sess-info').textContent = `متصل: ${c.owner}/${c.repo} (${c.branch}) — 🔐 التشفير مفعّل • محفوظ محلياً`;
  $('f-date').value = todayISO();
  renderOutbox();
}

// اختيار الريبو من القائمة بدل إدخاله يدوياً (المالك يُستنتج تلقائياً من full_name)
async function apiAuthed(url, token) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (res.status === 401) throw new Error('PAT غير صالح أو منتهي (401)');
  if (res.status === 403) throw new Error('ممنوع (403) — التوكن لا يملك الصلاحية أو تجاوز حد المعدل');
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

$('btn-fetch-repos').onclick = async () => {
  const token = $('in-token').value.trim();
  if (!token) return status($('login-status'), 'الصق الـ PAT أولاً', true);
  try {
    status($('login-status'), 'جارٍ جلب المستودعات... ⏳');
    $('btn-fetch-repos').disabled = true;
    const me = await apiAuthed('https://api.github.com/user', token);
    $('whoami').textContent = `مسجل كـ: ${me.login}`;
    const repos = await apiAuthed('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', token);
    const writable = repos.filter(r => r.permissions && r.permissions.push);
    if (!writable.length) {
      status($('login-status'), 'لا توجد مستودعات بصلاحية كتابة لهذا التوكن. أنشئ Fine-grained token على الريبو المطلوب بصلاحية Contents: Read and write.', true);
      return;
    }
    const sel = $('in-repo-select');
    sel.innerHTML = writable.map(r => `<option value="${esc(r.full_name)}">${esc(r.full_name)} ${r.private ? '🔒' : '🌍'}</option>`).join('');
    $('repo-wrap').classList.remove('hidden');
    await fillBranches();
    $('branch-wrap').classList.remove('hidden');
    $('pwd-wrap').classList.remove('hidden');
    $('pwd-warn').classList.remove('hidden');
    $('btn-login').classList.remove('hidden');
    status($('login-status'), `وجدنا ${writable.length} مستودعاً بصلاحية كتابة ✅ — اختر واحداً ثم ادخل`);
  } catch (e) { status($('login-status'), 'فشل: ' + e.message, true); }
  finally { $('btn-fetch-repos').disabled = false; }
};

async function fillBranches() {
  const token = $('in-token').value.trim();
  const full = $('in-repo-select').value; // owner/repo
  if (!full) return;
  const [owner, repo] = full.split('/');
  try {
    const brs = await apiAuthed(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`, token);
    const names = brs.map(b => b.name);
    if (!names.length) names.push('main');
    if (!names.includes('main')) names.unshift('main');
    $('in-branch-select').innerHTML = names.map(n => `<option ${n === 'main' ? 'selected' : ''}>${esc(n)}</option>`).join('');
  } catch {
    $('in-branch-select').innerHTML = '<option selected>main</option>';
  }
}
$('in-repo-select').onchange = fillBranches;

$('btn-login').onclick = async () => {
  const token = $('in-token').value.trim();
  const full = $('in-repo-select').value;
  const branch = $('in-branch-select').value || 'main';
  const pwd = $('in-pwd').value;
  if (!token) return status($('login-status'), 'أدخل الـ PAT — لا دخول بدونه', true);
  if (!full) return status($('login-status'), 'اختر الريبو من القائمة أولاً', true);
  if (!pwd || pwd.length < 4) return status($('login-status'), 'أدخل كلمة سر التشفير (4 أحرف على الأقل) — بدونها لا يمكن فك تشفير بياناتك', true);
  const [owner, repo] = full.split('/');
  try {
    status($('login-status'), 'جارٍ التحقق من صلاحية الكتابة... ⏳');
    $('btn-login').disabled = true;
    await validateWritePat(owner, repo, token);
    SS.setItem(S.owner, owner); SS.setItem(S.repo, repo);
    SS.setItem(S.branch, branch); SS.setItem(S.token, token);
    SS.setItem(S.pwd, pwd);
    MEM.key = null; MEM.saltB64 = null;
    $('in-token').value = ''; $('in-pwd').value = '';
    status($('login-status'), 'جارٍ تجهيز مفتاح التشفير... ⏳');
    await getKey(); // يجهّز الملح + يشتق المفتاح الآن لاكتشاف الخطأ مبكراً
    status($('login-status'), 'تم التحقق ✅');
    showApp();
    await loadEntries();
    syncOutbox(true); // بعد التحميل (تحتاج sha) — ترفع ما كان منتظراً دون إنترنت
  } catch (e) { status($('login-status'), 'فشل الدخول: ' + e.message, true); setConn(false); }
  finally { $('btn-login').disabled = false; }
};

function logout() {
  try { MEM.blobs.forEach(u => { try { URL.revokeObjectURL(u); } catch {} }); } catch {}
  [S.owner, S.repo, S.branch, S.token, S.pwd].forEach(k => SS.removeItem(k));
  MEM = { entries: [], sha: null, blobs: new Map(), pending: [], calCursor: new Date(), filterDate: '', key: null, saltB64: null, loaded: false };
  location.reload();
}
$('btn-logout').onclick = logout;
$('btn-relogin').onclick = logout;

// ---------- GitHub API (التوكن محفوظ محلياً) ----------
async function gh(path, opts = {}) {
  const c = ctx();
  if (!c.owner || !c.repo) throw new Error('بيانات الدخول مفقودة — سجّل الدخول من جديد');
  if (!c.token) throw new Error('لا يوجد PAT محفوظ');
  const res = await fetch(`https://api.github.com/repos/${c.owner}/${c.repo}/contents/${path}`, {
    ...opts,
    headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${c.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
  });
  if (res.status === 401) { logout(); throw new Error('PAT مرفوض — سجّل الدخول من جديد'); }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GitHub ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// ---------- ملفات → Base64 ----------
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const bytes = new Uint8Array(r.result);
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      res(btoa(bin));
    };
    r.onerror = rej;
    r.readAsArrayBuffer(file);
  });
}
const safeName = (n) => String(n || 'file').replace(/[^\w.\-\u0600-\u06FF]+/g, '_').slice(0, 80) || 'file';

// ---------- التشفير الكامل (AES-GCM + PBKDF2) ----------
// الملح محفوظ في data/crypto.json داخل الريبو (علني، وهذا آمن)، والمفتاح يُشتق من كلمة السر المحفوظة محلياً.
const ITER = 120000;
function b64e(u8) { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
function b64d(s) { return Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)); }

async function ensureSalt() {
  if (MEM.saltB64) return MEM.saltB64;
  // نسخة محلية من الملح (علني أصلاً) تتيح التشفير حتى دون إنترنت لقائمة الانتظار
  try { const ls = LS.getItem('gj_salt'); if (ls) { MEM.saltB64 = ls; return ls; } } catch {}
  const c = ctx();
  try {
    const j = await gh(`data/crypto.json?ref=${encodeURIComponent(c.branch)}`);
    const raw = new TextDecoder().decode(b64d(j.content));
    const o = JSON.parse(raw);
    if (!o.salt) throw new Error('salt');
    MEM.saltB64 = o.salt;
    try { LS.setItem('gj_salt', o.salt); } catch {}
    return MEM.saltB64;
  } catch (e) {
    if (String(e.message).includes('404') || String(e.message).includes('salt')) {
      // أول استخدام: ولّد ملحاً جديداً وارفعه (يتطلب كتابة — متوفرة)
      const salt = crypto.getRandomValues(new Uint8Array(16));
      MEM.saltB64 = b64e(salt);
      try { LS.setItem('gj_salt', MEM.saltB64); } catch {}
      const body = { message: 'journal: init crypto salt', content: btoa(JSON.stringify({ v: 1, alg: 'PBKDF2-SHA256-AES-GCM', iter: ITER, salt: MEM.saltB64 })), branch: c.branch };
      await gh('data/crypto.json', { method: 'PUT', body: JSON.stringify(body) });
      return MEM.saltB64;
    }
    throw e;
  }
}

async function getKey() {
  if (MEM.key) return MEM.key;
  const { pwd } = ctx();
  if (!pwd) throw new Error('كلمة سر التشفير مفقودة من التخزين — سجّل الدخول من جديد');
  const saltB64 = await ensureSalt();
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pwd), 'PBKDF2', false, ['deriveKey']);
  MEM.key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64d(saltB64), iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
  return MEM.key;
}

// bytes -> IV(12) || ciphertext
async function encBytes(rawU8) {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, rawU8));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0); out.set(ct, 12);
  return out;
}
async function decBytes(blob) {
  const key = await getKey();
  const iv = blob.slice(0, 12), data = blob.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, new Uint8Array(data));
  return new Uint8Array(pt);
}

// ---------- ضغط الصور قبل التشفير ----------
// الصور: تصغير لأقصى 1920px + JPEG بجودة 0.82. الفيديو الكبير (>10MB): إعادة ترميز لـ720p. الصوت الكبير (>8MB): إعادة ترميز منخفضة. الكل تلقائي.
function loadImageEl(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); rej(e); };
    img.src = url;
  });
}
async function compressImage(file) {
  try {
    const img = await loadImageEl(file);
    const MAX = 1920;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale >= 1 && file.size < 800 * 1024 && (file.type === 'image/jpeg' || file.type === 'image/webp')) return { blob: file, compressed: false };
    const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    const type = 'image/jpeg';
    const blob = await new Promise(r => cv.toBlob(r, type, 0.82));
    if (!blob || blob.size >= file.size) return { blob: file, compressed: false };
    return { blob: new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type }), compressed: true, ext: '.jpg' };
  } catch { return { blob: file, compressed: false }; }
}

// ---------- ضغط الفيديو والصوت تلقائياً (ترميز داخلي — بلا مكتبات ولا ffmpeg) ----------
// الطريقة: تشغيل الملف محلياً وإعادة تسجيله عبر MediaRecorder (فيديو 720p + صوت منخفض).
// يعمل بسرعة التشغيل (فيديو دقيقتين ≈ دقيقتان) مع نسبة تقدم. عند الفشل يُرفع الأصل كما هو.
function pickMime(cands) {
  try {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return cands.find(c => { try { return MediaRecorder.isTypeSupported(c); } catch { return false; } }) || '';
  } catch { return ''; }
}
function loadMediaEl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('video'); // عنصر فيديو يشغّل الصوت أيضاً لالتقاط مساره
    el.muted = true; el.playsInline = true; el.preload = 'auto'; el.src = url;
    const timer = setTimeout(() => reject(new Error('timeout')), 25000);
    el.onloadedmetadata = () => { clearTimeout(timer); resolve({ el, url }); };
    el.onerror = () => { clearTimeout(timer); URL.revokeObjectURL(url); reject(new Error('bad-media')); };
  });
}
async function transcodeMedia(file, opt, prog, label) {
  // opt: {video:bool, W,H,vbps,abps,mimes}
  let url = null, actx = null, raf = 0, drawing = false;
  try {
    const got = await loadMediaEl(file);
    const v = got.el; url = got.url;
    const dur = v.duration;
    if (!dur || !isFinite(dur) || dur <= 0) throw new Error('no-duration');
    if (dur > 20 * 60) throw new Error('too-long'); // أطول من 20 دقيقة: المعالجة أطول من المعقول
    const mime = pickMime(opt.mimes);
    if (!mime) throw new Error('no-recorder');
    const ext = mime.includes('mp4') ? '.mp4' : '.webm';
    const tracks = [];
    if (opt.video) {
      const canvas = document.createElement('canvas');
      canvas.width = opt.W; canvas.height = opt.H;
      const g = canvas.getContext('2d');
      drawing = true;
      const draw = () => { if (!drawing) return; try { g.drawImage(v, 0, 0, opt.W, opt.H); } catch {} raf = requestAnimationFrame(draw); };
      draw();
      tracks.push(...canvas.captureStream(30).getVideoTracks());
    }
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') { try { await actx.resume(); } catch {} }
      const src = actx.createMediaElementSource(v);
      const dst = actx.createMediaStreamDestination();
      src.connect(dst); // الصوت يُلتقط هنا (كتم العنصر لا يمنع الالتقاط)
      tracks.push(...dst.stream.getAudioTracks());
    } catch {}
    if (!tracks.length) throw new Error('no-tracks');
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, ...(opt.vbps ? { videoBitsPerSecond: opt.vbps } : {}), ...(opt.abps ? { audioBitsPerSecond: opt.abps } : {}) });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const finished = new Promise((res, rej) => { rec.onerror = () => rej(new Error('rec')); rec.onstop = res; });
    const onTime = () => { try { prog(`${label} ضغط تلقائي... ${Math.min(99, Math.round((v.currentTime / dur) * 100))}% ⏳ (لا تغلق الصفحة)`); } catch {} };
    v.addEventListener('timeupdate', onTime);
    rec.start(1000);
    await v.play();
    await new Promise((res) => { v.onended = res; v.onerror = res; });
    drawing = false; try { cancelAnimationFrame(raf); } catch {}
    try { if (rec.state !== 'inactive') rec.stop(); } catch {}
    await finished;
    try { actx && actx.close(); } catch {}
    URL.revokeObjectURL(url); url = null;
    const type = mime.split(';')[0];
    const out = new File([new Blob(chunks, { type })], (file.name || 'media').replace(/\.\w+$/, '') + ext, { type });
    if (!out.size || out.size >= file.size) return { blob: file, compressed: false };
    return { blob: out, compressed: true, ext, note: ` (ضُغط تلقائياً من ${(file.size / 1048576).toFixed(1)} إلى ${(out.size / 1048576).toFixed(1)}MB)` };
  } catch {
    drawing = false;
    try { cancelAnimationFrame(raf); } catch {}
    try { actx && actx.close(); } catch {}
    if (url) { try { URL.revokeObjectURL(url); } catch {} }
    return { blob: file, compressed: false };
  }
}
async function compressVideoAuto(file, prog, label) {
  let probe = null;
  try {
    const got = await loadMediaEl(file);
    probe = { w: got.el.videoWidth || 1280, h: got.el.videoHeight || 720, dur: got.el.duration || 0 };
    URL.revokeObjectURL(got.url);
  } catch { return { blob: file, compressed: false }; }
  if (!probe.dur || !isFinite(probe.dur)) return { blob: file, compressed: false };
  const sc = Math.min(1, 1280 / Math.max(probe.w, probe.h));
  const W = Math.max(2, Math.round(probe.w * sc / 2) * 2), H = Math.max(2, Math.round(probe.h * sc / 2) * 2);
  const targetBytes = Math.min(file.size * 0.5, 25 * 1048576);
  const vbps = Math.max(400000, Math.min(2500000, Math.floor((targetBytes * 8) / probe.dur)));
  return transcodeMedia(file, { video: true, W, H, vbps, abps: 64000, mimes: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'] }, prog, label);
}
async function compressAudioAuto(file, prog, label) {
  return transcodeMedia(file, { video: false, abps: 96000, mimes: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] }, prog, label);
}

// ---------- مصغّرات العرض (بدون تحميل الملف الكامل) ----------
// تُولّد وقت الرفع وتُخزن داخل اليومية (المشفرة أصلاً)، فتظهر القائمة فوراً بدون أي جلبة.
// الملف الكامل (خاصة الفيديو) لا يُحمّل إلا عند الضغط على مصغّره.
function fmtSize(b) {
  if (b == null) return '';
  return b > 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB';
}
function fmtDur(s) {
  if (!s || !isFinite(s)) return '';
  s = Math.round(s);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
async function makeImageThumb(blob) {
  try {
    const img = await loadImageEl(blob);
    const MAX = 320;
    const sc = Math.min(1, MAX / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round(img.naturalWidth * sc)), h = Math.max(1, Math.round(img.naturalHeight * sc));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    const tb = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.7));
    if (!tb) return null;
    return { b64: b64e(new Uint8Array(await tb.arrayBuffer())), w, h };
  } catch { return null; }
}
function makeVideoThumb(file) {
  // إطار واحد صغير (أول نصف ثانية) + المدة — بدون تحميل لاحق، الملف محلي هنا
  return new Promise((resolve) => {
    let settled = false;
    const url = URL.createObjectURL(file);
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); URL.revokeObjectURL(url); resolve(v); } };
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    const timer = setTimeout(() => done(null), 15000);
    v.onerror = () => done(null);
    v.onloadeddata = () => {
      const dur = v.duration || 0;
      const grab = () => {
        try {
          const vw = v.videoWidth || 320, vh = v.videoHeight || 180;
          const sc = Math.min(1, 320 / Math.max(vw, vh));
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(vw * sc)); cv.height = Math.max(1, Math.round(vh * sc));
          cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
          cv.toBlob(async (b) => {
            if (!b) return done({ b64: null, w: 0, h: 0, dur });
            done({ b64: b64e(new Uint8Array(await b.arrayBuffer())), w: cv.width, h: cv.height, dur });
          }, 'image/jpeg', 0.7);
        } catch { done({ b64: null, w: 0, h: 0, dur }); }
      };
      try {
        const t = dur && isFinite(dur) ? Math.min(0.5, dur / 2) : 0;
        if (t > 0) { v.onseeked = grab; v.currentTime = t; }
        else grab();
      } catch { grab(); }
    };
  });
}
function getMediaDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    el.preload = 'metadata'; el.src = url;
    const timer = setTimeout(() => { URL.revokeObjectURL(url); resolve(0); }, 10000);
    el.onloadedmetadata = () => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(el.duration || 0); };
    el.onerror = () => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(0); };
  });
}

// ---------- اليوميات (ملف entries.json مشفّر بالكامل) ----------
// شكل الملف في الريبو: {"v":1,"iv":"...","data":"..."} حيث data = AES-GCM(مصفوفة اليوميات JSON).
// ملفات data/crypto.json و entries.json و media/*.enc كلها غير مقروءة بدون كلمة السر.
async function loadEntries() {
  const c = ctx();
  try {
    const j = await gh(`data/entries.json?ref=${encodeURIComponent(c.branch)}`);
    MEM.sha = j.sha;
    const raw = new TextDecoder().decode(b64d(j.content));
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('ملف اليوميات تالف'); }
    if (Array.isArray(parsed)) {
      // بيانات قديمة غير مشفرة (قبل التشفير): تُقرأ وتُشفّر عند أول حفظ
      MEM.entries = parsed;
    } else if (parsed && parsed.v === 1 && parsed.iv && parsed.data) {
      try {
        const key = await getKey();
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(parsed.iv) }, key, b64d(parsed.data));
        MEM.entries = JSON.parse(new TextDecoder().decode(pt));
        if (!Array.isArray(MEM.entries)) MEM.entries = [];
      } catch {
        throw new Error('تعذّر فك التشفير — كلمة السر خاطئة أو البيانات مشفرة بكلمة أخرى');
      }
    } else throw new Error('ملف اليوميات بصيغة غير معروفة');
    setConn(true);
  } catch (e) {
    if (String(e.message).includes('404')) { MEM.entries = []; MEM.sha = null; setConn(true); }
    else { setConn(false); throw e; }
  }
  MEM.loaded = true;
  renderAll();
}

async function persistEntries(msg) {
  const c = ctx();
  const key = await getKey();
  const json = JSON.stringify(MEM.entries);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json)));
  const wrapper = JSON.stringify({ v: 1, alg: 'AES-GCM-256-PBKDF2', iv: b64e(iv), data: b64e(ct) });
  const body = { message: msg, content: btoa(new TextEncoder().encode(wrapper).reduce((d, b) => d + String.fromCharCode(b), '')), branch: c.branch };
  if (MEM.sha) body.sha = MEM.sha;
  const j = await gh('data/entries.json', { method: 'PUT', body: JSON.stringify(body) });
  MEM.sha = j.content.sha;
}

function addFiles(list) {
  for (const f of list) {
    MEM.pending.push({ uid: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), file: f, name: f.name, note: '' });
  }
  renderPending();
}
$('f-files').onchange = () => { addFiles($('f-files').files); $('f-files').value = ''; };

// أزرار رفع مخصصة وواضحة: كل زر يفتح الاختيار على نوعه مباشرة (خاصة الصوت 🔊)
function pickAs(accept) {
  const i = $('f-files');
  i.accept = accept;
  i.click();
  setTimeout(() => { i.accept = 'image/*,video/*,audio/*'; }, 2000);
}
{
  const pa = $('btn-pick-audio'), pi = $('btn-pick-image'), pv = $('btn-pick-video');
  if (pa) pa.onclick = () => pickAs('audio/*');
  if (pi) pi.onclick = () => pickAs('image/*');
  if (pv) pv.onclick = () => pickAs('video/*');
}

// سحب وإفلات عدة ملفات دفعة واحدة (سطح المكتب) — على الهاتف: حدّد عدة عناصر من المعرض مباشرة
{
  const dz = $('entry-card');
  if (dz) {
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag-over'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag-over'); }));
    dz.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  }
}
function renderPending() {
  const ac = $('att-count');
  if (ac) ac.textContent = MEM.pending.length ? `— المرفق الآن: ${MEM.pending.length} ملفات` : '';
  $('pending-files').innerHTML = MEM.pending.map((it, i) => {
    const f = it.file;
    return `<div class="pend-row">
      <div class="pend-top"><span class="chip">📎 ${esc(f.name)} (${(f.size / 1024 / 1024).toFixed(1)}MB)</span><a href="#" data-rm="${i}">✕</a></div>
      <input data-nm="${i}" placeholder="✏️ اسم العرض (اختياري — يظهر بدل اسم الملف)" value="${esc(it.name)}" />
      <input data-nt="${i}" placeholder="📝 ملاحظة على هذا الملف (اختياري)" value="${esc(it.note)}" />
    </div>`;
  }).join('');
  $('pending-files').querySelectorAll('[data-rm]').forEach(a => a.onclick = (e) => { e.preventDefault(); MEM.pending.splice(+a.dataset.rm, 1); renderPending(); });
  $('pending-files').querySelectorAll('[data-nm]').forEach(inp => inp.oninput = () => { MEM.pending[+inp.dataset.nm].name = inp.value; });
  $('pending-files').querySelectorAll('[data-nt]').forEach(inp => inp.oninput = () => { MEM.pending[+inp.dataset.nt].note = inp.value; });
}

// تجهيز الملفات (ضغط + مصغّر + بايتات + مسار ثابت) — مشترك بين الحفظ المباشر وقائمة الانتظار
async function prepareItems(items, date, prog) {
  const prepared = [];
  let totalRaw = 0, fi = 0;
  for (const it of items) {
    fi++;
    const f = it.file;
    let disp = ((it.name || f.name) + '').trim() || f.name;
    const kind = f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : 'audio';
    let upFile = f, compNote = '';
    if (kind === 'image') {
      prog(`ضغط الصورة ${fi}/${items.length}... 🗜️`);
      const r = await compressImage(f);
      upFile = r.blob;
      if (r.compressed) { compNote = ` (ضُغطت من ${(f.size / 1048576).toFixed(1)} إلى ${(upFile.size / 1048576).toFixed(1)}MB)`; disp = disp.replace(/\.\w+$/, '') + '.jpg'; }
    } else if (kind === 'video' && f.size > 10 * 1048576) {
      // فيديو كبير: إعادة ترميز تلقائية لـ720p — أنت لا تفعل شيئاً
      const r = await compressVideoAuto(f, prog, `🎬 ${fi}/${items.length}`);
      upFile = r.blob;
      if (r.compressed) { compNote = r.note || ''; if (r.ext) disp = disp.replace(/\.\w+$/, '') + r.ext; }
    } else if (kind === 'audio' && f.size > 8 * 1048576) {
      // صوت كبير: إعادة ترميز تلقائية منخفضة — أنت لا تفعل شيئاً
      const r = await compressAudioAuto(f, prog, `🔊 ${fi}/${items.length}`);
      upFile = r.blob;
      if (r.compressed) { compNote = r.note || ''; if (r.ext) disp = disp.replace(/\.\w+$/, '') + r.ext; }
    }
    if (upFile.size > 500 * 1048576) throw new Error(`الملف "${disp}" أكبر من 500MB — ذاكرة المتصفح لا تستوعبه. قسّمه لأجزاء أصغر.`);
    const bytes = new Uint8Array(await upFile.arrayBuffer());
    totalRaw += bytes.length;
    let thumb = null, tw = 0, th = 0, dur = 0;
    try {
      if (kind === 'image') {
        prog(`مصغّر الصورة ${fi}/${items.length}... 🖼️`);
        const t = await makeImageThumb(upFile);
        if (t) { thumb = t.b64; tw = t.w; th = t.h; }
      } else if (kind === 'video') {
        prog(`مصغّر الفيديو ${fi}/${items.length}... 🎬`);
        const t = await makeVideoThumb(upFile);
        if (t) { thumb = t.b64; tw = t.w || 0; th = t.h || 0; dur = t.dur || 0; }
        if (!dur) dur = await getMediaDuration(upFile);
      } else {
        dur = await getMediaDuration(upFile);
      }
    } catch { /* المصغّر اختياري — يُعرض زر تحميل بدلاً منه */ }
    prepared.push({ src: disp, kind, mime: upFile.type || 'application/octet-stream', bytes, url: URL.createObjectURL(upFile), compNote, note: ((it.note || '') + '').trim(), thumb, tw, th, dur, path: `media/${date}/${Date.now()}_${fi}_${safeName(disp)}.enc` });
  }
  if (totalRaw > 800 * 1048576) throw new Error('مجموع الملفات أكبر من 800MB — وزّعها على أكثر من يومية.');
  return prepared;
}

// ---------- الرفع المجمّع: ملف واحد أو مجزأ لقطع (للملفات الضخمة بلا حد من التطبيق) ----------
// سقف GitHub الصلب: ~100MB للملف الواحد عبر API + ~1GB لحجم الموقع — لذلك الملفات الكبيرة
// تُقسّم لقطع 20MB (كل قطعة مشفرة بـIV مستقل) وتُجمّع عند العرض. سقف الأمان الوحيد: 500MB لذاكرة الجهاز.
const CHUNK = 20 * 1048576, SINGLE_MAX = 40 * 1048576;
async function existsPath(path, branch) {
  try { await gh(`${path}?ref=${encodeURIComponent(branch)}`); return true; }
  catch (err) { if (String(err.message).includes('404')) return false; throw err; }
}
async function putPath(path, u8, branch, msg) {
  await gh(path, { method: 'PUT', body: JSON.stringify({ message: msg || `journal: add ${path}`, content: b64e(u8), branch }) });
}
// p: {path, src, kind, mime, thumb, tw, th, dur, note, compNote} + rawU8 — يعيد وصف المرفق
async function uploadPayload(p, rawU8, c, prog, idx, total) {
  const tag = total > 1 ? `${idx}/${total}: ` : '';
  const meta = { path: p.path, kind: p.kind, name: p.src, size: rawU8.length, enc: true, mime: p.mime, thumb: p.thumb, tw: p.tw, th: p.th, dur: p.dur, note: p.note };
  if (rawU8.length <= SINGLE_MAX) {
    if (await existsPath(p.path, c.branch)) {
      prog(`تخطي ${tag}${p.src} (مرفوع سابقاً) ✅`);
    } else {
      prog(`تشفير ورفع ${tag}${p.src}${p.compNote || ''} 🔐`);
      await putPath(p.path, await encBytes(rawU8), c.branch);
    }
    return meta;
  }
  const prefix = p.path.replace(/\.enc$/, '');
  const n = Math.ceil(rawU8.length / CHUNK);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const pp = `${prefix}.part${String(i + 1).padStart(3, '0')}.enc`;
    parts.push(pp);
    if (await existsPath(pp, c.branch)) { prog(`تخطي قطعة ${i + 1}/${n} من ${p.src} ✅`); continue; }
    prog(`رفع قطعة ${i + 1}/${n} من ${p.src}... 🧩`);
    await putPath(pp, await encBytes(rawU8.subarray(i * CHUNK, Math.min(rawU8.length, (i + 1) * CHUNK))), c.branch, `journal: part ${i + 1}/${n} ${pp}`);
  }
  meta.chunked = true;
  meta.parts = parts;
  return meta;
}

// رفع المعدّ (يتخطى الموجود — للاستئناف) ويعيد بيانات المرفقات — مشترك بين المباشر والمزامنة
async function uploadPrepared(prepared, c, prog) {
  const atts = [];
  let ui = 0;
  for (const p of prepared) {
    ui++;
    atts.push(await uploadPayload(p, p.bytes, c, prog, ui, prepared.length));
    cacheBlob(p.path, p.url); // مؤقت فقط — يُزال من الذاكرة فور نجاح الحفظ
  }
  return atts;
}

function clearEntryForm() {
  $('f-title').value = $('f-text').value = '';
  MEM.pending = []; MEM.blobs.delete('__rec');
  try { const rp = $('rec-preview'); if (rp.src && rp.src.startsWith('blob:')) URL.revokeObjectURL(rp.src); rp.removeAttribute('src'); } catch {}
  $('rec-preview').classList.add('hidden');
  renderPending();
}

$('btn-save-entry').onclick = async () => {
  const title = $('f-title').value.trim(), text = $('f-text').value.trim();
  const date = $('f-date').value || todayISO();
  if (!title && !text && MEM.pending.length === 0 && !MEM.blobs.has('__rec')) return alert('اكتب شيئاً أو أرفق ملفاً أولاً');
  if (MEM.pending.some(p => p.file.size > 500 * 1024 * 1024)) return alert('ملف أكبر من 500MB — المتصفح لا يستطيع معالجته. قسّمه أولاً.');
  const prog = (m) => status($('save-status'), m);
  try {
    const c = ctx();
    if (!c.pwd) throw new Error('كلمة سر التشفير مفقودة — سجّل الدخول من جديد');
    uploading = true;
    const items = [...MEM.pending];
    const recBlob = MEM.blobs.get('__rec');
    if (recBlob) items.push({ uid: 'rec' + Date.now(), file: new File([recBlob], `voice_${Date.now()}.webm`, { type: recBlob.type || 'audio/webm' }), name: '🎙️ تسجيل صوتي', note: '' });
    const mood = $('f-mood').value;

    // دون إنترنت: حفظ محلي في قائمة الانتظار (IndexedDB) والرفع تلقائياً عند عودته
    if (!navigator.onLine) {
      prog('لا إنترنت — تجهيز وحفظ محلياً... 📥');
      const prepared = await prepareItems(items, date, prog);
      // تُخزن خاماً دائماً هنا (التشفير لحظة الرفع — يدعم التجزئة للضخم)، والمصغّرات جاهزة للعرض المحلي
      const files = [];
      for (const p of prepared) {
        files.push({ path: p.path, src: p.src, kind: p.kind, mime: p.mime, size: p.bytes.length, thumb: p.thumb, tw: p.tw, th: p.th, dur: p.dur, note: p.note, blob: new Blob([p.bytes], { type: 'application/octet-stream' }), enc: false });
        try { URL.revokeObjectURL(p.url); } catch {}
      }
      await outboxPut({ id: 'q' + Date.now(), date, title: title || '(بدون عنوان)', text: text || '', mood, createdAt: new Date().toISOString(), files, status: 'pending', error: '' });
      clearEntryForm();
      prog('حُفظ محلياً 📥 — سيُشفّر ويُرفع تلقائياً عند عودة الاتصال');
      renderOutbox();
      return;
    }

    const prepared = await prepareItems(items, date, prog);
    const atts = await uploadPrepared(prepared, c, prog);
    prog('تشفير اليومية وحفظها... 🔐');
    MEM.entries.unshift({ id: 'e' + Date.now(), date, title: title || '(بدون عنوان)', text: text || '', mood, createdAt: new Date().toISOString(), attachments: atts });
    await persistEntries(`journal: new entry ${date}`);
    clearEntryForm();
    // إزالة المرفوعات من الذاكرة فوراً — المصغّرات تكفي للعرض، والكامل يُحمّل عند الضغط عليه
    for (const a of atts) dropBlob(a.path);
    prog('تم الحفظ في GitHub ✅ — المرفوعات أُزيلت من الذاكرة، اضغط أي مصغّر للعرض (يُحذف تلقائياً بعد 24 ساعة)');
    renderAll();
  } catch (e) { prog('خطأ: ' + e.message + ' — اضغط حفظ مجدداً وسيُكمل من حيث توقف (المرفوع يُتخطى)', true); }
  finally { uploading = false; }
};

// ---------- قائمة الانتظار دون إنترنت (IndexedDB — تبقى بعد إغلاق المتصفح) ----------
// اليومية تُحفظ محلياً (مشفرة إن توفر الملح، وإلا خاماً لتُشفّر لحظة الرفع) وتُرفع تلقائياً عند عودة الاتصال.
// تنبيه صدق: البنود غير المشفرة (enc:false) تبقى خاماً على هذا الجهاز حتى تُرفع — جهازك الخاص فقط.
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ghjournal', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function outboxPut(item) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put(item);
    tx.oncomplete = () => { db.close(); res(); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
async function outboxDel(id) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').delete(id);
    tx.oncomplete = () => { db.close(); res(); };
    tx.onerror = () => { db.close(); rej(tx.error); };
  });
}
async function outboxList() {
  try {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction('outbox', 'readonly');
      const q = tx.objectStore('outbox').getAll();
      q.onsuccess = () => { db.close(); res(q.result || []); };
      q.onerror = () => { db.close(); rej(q.error); };
    });
  } catch { return []; }
}

async function renderOutbox() {
  const card = $('outbox-card');
  if (!card) return;
  let items = [];
  try { items = await outboxList(); } catch {}
  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  card.classList.toggle('hidden', items.length === 0);
  if (!items.length) return;
  $('outbox-info').textContent = navigator.onLine
    ? 'متصل — جارٍ الرفع التلقائي...' : 'غير متصل — محفوظة على هذا الجهاز وستُرفع تلقائياً عند عودة الإنترنت';
  $('outbox-list').innerHTML = items.map(it => {
    const st = it.status === 'uploading' ? '⏳ يُرفع...' : it.status === 'failed' ? `⚠️ فشل: ${esc(it.error || '')}` : (it.enc === false || (it.files || []).some(f => !f.enc) ? '📥 محفوظة محلياً (غير مشفرة بعد)' : '📥 محفوظة محلياً (مشفرة)');
    return `<div class="pend-row">
      <div class="pend-top"><strong>${esc(it.title)}</strong><span class="muted">${esc(it.date)} • ${it.files.length} ملفات</span></div>
      <div class="muted">${st}</div>
      <div class="row"><button data-sync="${it.id}">↻ رفع الآن</button><button data-qdel="${it.id}">🗑 حذف</button></div>
    </div>`;
  }).join('');
  $('outbox-list').querySelectorAll('[data-sync]').forEach(b => b.onclick = () => syncOutbox(false, b.dataset.sync));
  $('outbox-list').querySelectorAll('[data-qdel]').forEach(b => b.onclick = async () => {
    if (!confirm('حذف هذه اليومية من قائمة الانتظار؟ (لن تُرفع — انتبه: ما رُفع جزئياً يبقى في الريبو)')) return;
    await outboxDel(b.dataset.qdel);
    renderOutbox();
  });
}

let syncing = false;
async function syncOutbox(auto, onlyId) {
  if (syncing) return;
  if (!navigator.onLine) { renderOutbox(); return; }
  const c = ctx();
  if (!c.token || !c.pwd) return;
  // المزامنة تكتب فوق entries.json فتحتاج sha محمّلاً — حمّل أولاً إن لزم
  if (!MEM.loaded) {
    try { await loadEntries(); } catch { renderOutbox(); return; }
  }
  let items = await outboxList();
  if (onlyId) items = items.filter(x => x.id === onlyId);
  if (!items.length) { renderOutbox(); return; }
  syncing = true;
  try { await getKey(); } catch (e) { syncing = false; renderOutbox(); return; }
  for (const it of items) {
    if (!navigator.onLine) break;
    it.status = 'uploading'; it.error = '';
    await outboxPut(it); renderOutbox();
    try {
      const atts = [];
      let si = 0;
      for (const f of it.files) {
        si++;
        const raw = new Uint8Array(await f.blob.arrayBuffer());
        atts.push(await uploadPayload({ path: f.path, src: f.src, kind: f.kind, mime: f.mime, thumb: f.thumb, tw: f.tw, th: f.th, dur: f.dur, note: f.note, compNote: '' }, raw, c, () => {}, si, it.files.length));
      }
      MEM.entries.unshift({ id: 'e' + Date.now(), date: it.date, title: it.title, text: it.text, mood: it.mood, createdAt: it.createdAt, attachments: atts });
      await persistEntries(`journal: sync offline ${it.date}`);
      await outboxDel(it.id);
    } catch (e) {
      it.status = 'failed'; it.error = String(e.message || e).slice(0, 120);
      await outboxPut(it);
    }
  }
  syncing = false;
  renderOutbox();
  renderAll();
}

// عودة الإنترنت: إن كنا داخل التطبيق دون بيانات (دخول دون إنترنت) حمّلها أولاً ثم زامن
async function goOnlineRefresh() {
  renderOutbox();
  const c = ctx();
  if (!c.token || !c.pwd) return;
  if ($('screen-app').classList.contains('hidden')) return;
  if (!MEM.loaded) {
    try {
      await validateWritePat(c.owner, c.repo, c.token);
      await getKey();
      showApp();
      await loadEntries();
    } catch { return; }
  }
  syncOutbox(true);
}
window.addEventListener('online', goOnlineRefresh);
window.addEventListener('offline', () => renderOutbox());

// ---------- عرض + تقويم + بحث ----------
function renderAll() { renderCalendar(); renderEntries(); }

function renderCalendar() {
  const cur = MEM.calCursor, y = cur.getFullYear(), m = cur.getMonth();
  $('cal-title').textContent = cur.toLocaleDateString('ar', { month: 'long', year: 'numeric' });
  const counts = {};
  MEM.entries.forEach(e => counts[e.date] = (counts[e.date] || 0) + 1);
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  let html = ['سبت', 'أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة'].map(d => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < (first + 1) % 7; i++) html += '<div></div>';
  for (let d = 1; d <= days; d++) {
    const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const n = counts[iso] || 0;
    html += `<div class="day ${n ? 'has' : ''} ${MEM.filterDate === iso ? 'sel' : ''}" data-day="${iso}">${d}${n ? `<span class="dot">• ${n}</span>` : ''}</div>`;
  }
  $('calendar').innerHTML = html;
  $('calendar').querySelectorAll('[data-day]').forEach(el => el.onclick = () => {
    MEM.filterDate = MEM.filterDate === el.dataset.day ? '' : el.dataset.day;
    $('q-date').value = MEM.filterDate;
    renderAll();
  });
}
$('cal-prev').onclick = () => { MEM.calCursor.setMonth(MEM.calCursor.getMonth() - 1); renderCalendar(); };
$('cal-next').onclick = () => { MEM.calCursor.setMonth(MEM.calCursor.getMonth() + 1); renderCalendar(); };
$('q-search').oninput = renderEntries;
$('q-date').onchange = (e) => { MEM.filterDate = e.target.value; renderEntries(); };
$('btn-reload').onclick = async () => { try { await loadEntries(); } catch (e) { alert(e.message); } };

function paintFullHTML(kind, name, url, note) {
  // عرض مضمّن داخل المتصفح + زر تنزيل لفتح الملف في عارض/معرض الهاتف
  const media = kind === 'image' ? `<img loading="lazy" src="${url}" alt="${esc(name)}" />`
    : kind === 'video' ? `<video controls autoplay preload="metadata" playsinline src="${url}"></video>`
    : `<audio controls autoplay preload="metadata" src="${url}"></audio>`;
  return `<div class="full-media">${media}${note ? `<div class="full-note">📝 ${esc(note)}</div>` : ''}<a class="dl-btn" href="${url}" download="${esc(name)}" title="تنزيل الملف لفتحه في عارض الهاتف">⬇ تنزيل / فتح في عارض الهاتف</a></div>`;
}

function thumbCardHTML(o) {
  // بطاقة مصغّرة: لا تُحدث أي جلبة — الضغط عليها يجمّل هذا الملف وحده
  const sub = [fmtSize(o.size), fmtDur(o.dur)].filter(Boolean).join(' • ');
  const visual = o.thumb
    ? `<img loading="lazy" src="data:image/jpeg;base64,${o.thumb}" alt="${esc(o.name)}" />`
    : `<div class="tc-icon">${o.kind === 'image' ? '🖼️' : o.kind === 'video' ? '🎬' : '🔊'}</div>`;
  const badge = o.kind === 'video' ? '<span class="tc-play">▶</span>' : o.kind === 'audio' ? '<span class="tc-play">🔊</span>' : '<span class="tc-play">🔍</span>';
  const ref = o.t === 'zip'
    ? `data-t="zip" data-bp="${esc(o.bp)}" data-in="${esc(o.inner)}"`
    : `data-t="file" data-path="${esc(o.path)}"${o.parts ? ` data-parts="${encodeURIComponent(JSON.stringify(o.parts))}"` : ''}`;
  return `<button class="thumb-card" data-eid="${esc(o.eid)}" data-kind="${esc(o.kind)}" data-nm="${esc(o.name)}" data-mime="${esc(o.mime || '')}" data-note="${esc(o.note || '')}" ${ref}>${visual}${badge}<span class="tc-meta">${esc(o.name)}${sub ? ' • ' + esc(sub) : ''}</span>${o.note ? `<span class="tc-note">📝 ${esc(o.note)}</span>` : ''}</button>`;
}

function mediaTag(a, idx, eid) {
  const cached = getBlob(a.path);
  if (cached) return paintFullHTML(a.kind, a.name, cached, a.note);
  return thumbCardHTML({ t: 'file', eid, kind: a.kind, name: a.name, mime: a.mime, size: a.size, dur: a.dur, thumb: a.thumb, path: a.path, note: a.note, parts: a.parts });
}

function bundleTag(e, f, idx) {
  const key = e.bundle.path + '#' + f.zip;
  const cached = getBlob(key);
  if (cached) return paintFullHTML(f.kind, f.name, cached, f.note);
  return thumbCardHTML({ t: 'zip', eid: e.id, kind: f.kind, name: f.name, mime: f.mime, size: f.size, dur: f.dur, thumb: f.thumb, bp: e.bundle.path, inner: f.zip, note: f.note });
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}

async function downloadEntry(id) {
  const e = MEM.entries.find(x => x.id === id);
  if (!e) return;
  try {
    status($('save-status'), 'تجهيز ZIP للتنزيل... ⏳');
    if (e.bundle) {
      // الحزمة المفكوكة هي ZIP صالح جاهز للتنزيل مباشرة
      const c = ctx();
      const j = await gh(`${e.bundle.path}?ref=${encodeURIComponent(c.branch)}`);
      const zipBytes = await decBytes(b64d(j.content));
      saveBlob(new Blob([zipBytes], { type: 'application/zip' }), `journal_${e.date}_${e.id}.zip`);
    } else if (e.attachments?.length) {
      if (typeof fflate === 'undefined' || !fflate.zipSync) return alert('مكتبة ZIP غير متاحة (CDN محجوب) — لا يمكن التجميع');
      const c = ctx();
      const inner = {};
      for (const a of e.attachments) {
        const cached = getBlob(a.path);
        if (cached) {
          inner[safeName(a.name)] = new Uint8Array(await (await fetch(cached)).arrayBuffer());
        } else if (a.chunked && a.parts) {
          const chunks = [];
          for (const pp of a.parts) {
            const j = await gh(`${pp}?ref=${encodeURIComponent(c.branch)}`);
            chunks.push(await decBytes(b64d(j.content)));
          }
          const total = chunks.reduce((s, x) => s + x.length, 0);
          const all = new Uint8Array(total);
          let off = 0;
          for (const x of chunks) { all.set(x, off); off += x.length; }
          inner[safeName(a.name)] = all;
        } else {
          const j = await gh(`${a.path}?ref=${encodeURIComponent(c.branch)}`);
          inner[safeName(a.name)] = await decBytes(b64d(j.content));
        }
      }
      saveBlob(new Blob([fflate.zipSync(inner, { level: 6 })], { type: 'application/zip' }), `journal_${e.date}_${e.id}.zip`);
    } else return alert('لا مرفقات في هذه اليومية');
    status($('save-status'), 'تم تنزيل ZIP ✅ (ملفات مفكوكة التشفير — احفظه في مكان آمن)');
  } catch (err) { alert('تعذّر التنزيل: ' + err.message); status($('save-status'), '', false); }
}

function renderEntries() {
  const q = ($('q-search').value || '').trim();
  const list = MEM.entries.filter(e =>
    (!MEM.filterDate || e.date === MEM.filterDate) &&
    (!q || (e.title + ' ' + e.text).includes(q))
  );
  $('entries').innerHTML = list.length ? '' : '<p class="muted">لا توجد يوميات بعد. أضف أول يومية بالأعلى ✍️</p>';
  for (const e of list) {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = `<h3>${esc(e.title)}</h3>
      <div class="meta">📅 ${esc(e.date)} ${esc(e.mood || '')} • ${new Date(e.createdAt).toLocaleString('ar')}</div>
      <div>${esc(e.text).replace(/\n/g, '<br>')}</div>
      ${e.bundle?.files?.length ? `<div class="atts">${e.bundle.files.map((f, j) => bundleTag(e, f, e.id + '_b' + j)).join('')}</div>` : ''}
      ${e.attachments?.length ? `<div class="atts">${e.attachments.map((a, j) => mediaTag(a, e.id + '_' + j, e.id)).join('')}</div>` : ''}
      <div class="row">${(e.bundle?.files?.length || e.attachments?.length) ? `<button data-all="${e.id}">▶ تحميل الكل</button>` : ''}<button data-dl="${e.id}">⬇️ تنزيل ZIP</button><button data-del="${e.id}">🗑 حذف</button></div>`;
    $('entries').appendChild(div);
  }
  // لا تحميل تلقائي إطلاقاً — المصغّرات معروضة سلفاً، والضغط يجمّل الملف المطلوب وحده
  $('entries').querySelectorAll('.thumb-card').forEach(card => card.onclick = () => openCard(card));
  $('entries').querySelectorAll('[data-all]').forEach(b => b.onclick = () => loadAllEntry(b.dataset.all));
  $('entries').querySelectorAll('[data-dl]').forEach(b => b.onclick = () => downloadEntry(b.dataset.dl));
  $('entries').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('حذف هذه اليومية؟ (يبقى ملف الوسائط في الريبو)')) return;
    MEM.entries = MEM.entries.filter(x => x.id !== b.dataset.del);
    try { await persistEntries('journal: delete entry'); renderAll(); }
    catch (e) { alert('خطأ: ' + e.message); }
  });
}

// ---------- التحميل عند الطلب فقط (لا جلب تلقائي) ----------
// الحزمة تُجلب مرة واحدة للجلسة وتُحفظ مفكوكة في الذاكرة؛ كل ملف إضافي منها بلا جلبة جديدة.
async function getUnzippedBundle(bpath) {
  MEM.zipCache = MEM.zipCache || {};
  MEM.zipJobs = MEM.zipJobs || {};
  if (MEM.zipCache[bpath]) return MEM.zipCache[bpath];
  if (!MEM.zipJobs[bpath]) {
    MEM.zipJobs[bpath] = (async () => {
      const c = ctx();
      const r = await gh(`${bpath}?ref=${encodeURIComponent(c.branch)}`);
      const map = fflate.unzipSync(await decBytes(b64d(r.content)));
      MEM.zipCache[bpath] = map;
      (MEM.zipAt = MEM.zipAt || new Map()).set(bpath, Date.now());
      return map;
    })().catch(err => { delete MEM.zipJobs[bpath]; throw err; });
  }
  return MEM.zipJobs[bpath];
}

async function openCard(card) {
  if (!card || card.disabled) return;
  card.disabled = true;
  const meta = card.querySelector('.tc-meta');
  const orig = meta ? meta.textContent : '';
  if (meta) meta.textContent = '⏳ تحميل وفك تشفير...';
  try {
    const kind = card.dataset.kind, nm = card.dataset.nm, mime = card.dataset.mime || 'application/octet-stream';
    const note = card.dataset.note || '';
    let url;
    if (card.dataset.t === 'zip') {
      const bpath = card.dataset.bp, inner = card.dataset.in;
      const key = bpath + '#' + inner;
      url = getBlob(key);
      if (!url) {
        if (typeof fflate === 'undefined' || !fflate.unzipSync) throw new Error('مكتبة ZIP غير متاحة');
        const map = await getUnzippedBundle(bpath);
        const raw = map[inner];
        if (!raw) throw new Error('الملف غير موجود داخل الحزمة');
        url = URL.createObjectURL(new Blob([raw], { type: mime }));
        cacheBlob(key, url);
      }
    } else {
      const path = card.dataset.path;
      url = getBlob(path);
      if (!url) {
        const c = ctx();
        const parts = card.dataset.parts ? JSON.parse(decodeURIComponent(card.dataset.parts)) : null;
        if (parts && parts.length) {
          // ملف مجزأ: جلب القطع بالتتابع مع تقدم ثم تجميعها وفك تشفيرها
          const chunks = [];
          for (let i = 0; i < parts.length; i++) {
            if (meta) meta.textContent = `⏳ تحميل قطعة ${i + 1}/${parts.length}...`;
            const r = await gh(`${parts[i]}?ref=${encodeURIComponent(c.branch)}`);
            chunks.push(await decBytes(b64d(r.content)));
          }
          const total = chunks.reduce((s, x) => s + x.length, 0);
          const all = new Uint8Array(total);
          let off = 0;
          for (const x of chunks) { all.set(x, off); off += x.length; }
          url = URL.createObjectURL(new Blob([all], { type: mime }));
        } else {
          const r = await gh(`${path}?ref=${encodeURIComponent(c.branch)}`);
          url = URL.createObjectURL(new Blob([await decBytes(b64d(r.content))], { type: mime }));
        }
        cacheBlob(path, url);
      }
    }
    const tmp = document.createElement('div');
    tmp.innerHTML = paintFullHTML(kind, nm, url, note);
    card.replaceWith(tmp.firstChild);
  } catch (err) {
    card.disabled = false;
    if (meta) meta.textContent = '⚠️ ' + (err.message || 'تعذّر التحميل') + ' — اضغط لإعادة المحاولة';
    else card.title = String(err.message || err);
    void orig;
  }
}

async function loadAllEntry(id) {
  const cards = [...document.querySelectorAll(`.thumb-card[data-eid="${CSS.escape(id)}"]`)];
  for (const card of cards) await openCard(card);
}

// ---------- تسجيل الصوت ----------
let MR = null, chunks = [], recTimer = null, recSec = 0;
$('btn-record').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    MR = new MediaRecorder(stream);
    MR.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    MR.onstop = () => {
      const blob = new Blob(chunks, { type: MR.mimeType || 'audio/webm' });
      MEM.blobs.set('__rec', blob);
      $('rec-preview').src = URL.createObjectURL(blob);
      $('rec-preview').classList.remove('hidden');
      stream.getTracks().forEach(t => t.stop());
    };
    MR.start();
    recSec = 0;
    $('btn-record').classList.add('hidden');
    $('btn-stop-record').classList.remove('hidden');
    $('btn-stop-record').disabled = false;
    clearInterval(recTimer);
    recTimer = setInterval(() => { recSec++; $('rec-time').textContent = recSec; }, 1000);
  } catch { alert('تعذّر الوصول للمايك — تحقق من إذن المتصفح (HTTPS مطلوب)'); }
};
$('btn-stop-record').onclick = () => {
  MR?.stop();
  clearInterval(recTimer);
  $('btn-stop-record').classList.add('hidden');
  $('btn-record').classList.remove('hidden');
};

// ---------- بدء: استعد الدخول المحفوظ إن وجد، وإلا شاشة الدخول ----------
// دون إنترنت وبيانات محفوظة: دخول لوضع عدم الاتصال (إضافة لقائمة الانتظار تعمل، العرض يحتاج شبكة).
// مهم: انقطاع الشبكة لا يمسح المحفوظ أبداً — المسح فقط عند رفض المصادقة (401/403/404).
function isAuthError(e) {
  return /401|403|404|مرفوض|صلاحية|غير موجود/.test(String((e && e.message) || e || ''));
}
function clearCreds() { [S.owner, S.repo, S.branch, S.token, S.pwd].forEach(k => SS.removeItem(k)); MEM.key = null; }
function enterOffline() {
  showApp();
  MEM.entries = []; MEM.sha = null; MEM.loaded = false;
  const c = ctx();
  $('sess-info').textContent = `📴 دون إنترنت — ${c.owner}/${c.repo} — يمكنك الإضافة وستُحفظ في قائمة الانتظار`;
  renderAll();
  renderOutbox();
}
(async function boot() {
  initTheme();
  // نظافة: امسح أي بقايا قديمة من النسخة السابقة (كلمة سر/توكن دائم)
  ['gj_lock_hash', 'gj_device_id', 'gj_bind', 'gj_settings', 'gj_token_local', 'gj_token'].forEach(k => LS.removeItem(k));
  const c = ctx();
  if (c.token && c.owner && c.repo && c.pwd) {
    if (!navigator.onLine) { enterOffline(); return; }
    try {
      await validateWritePat(c.owner, c.repo, c.token);
      await getKey();
      showApp();
      await loadEntries();
      syncOutbox(true);
      return;
    } catch (e) {
      if (!navigator.onLine || !isAuthError(e)) { enterOffline(); return; }
      clearCreds();
    }
  }
  showLogin();
})();
