/* GHjournal service worker — app shell يعمل دون إنترنت.
   القاعدة: GitHub API والوسائط لا تُخزّن أبداً (خصوصية + حداثة). فقط ملفات التطبيق الثابتة. */
const V = 'ghjournal-v1';
const CORE = [
  './', './index.html',
  './css/style.css', './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable.png', './icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(V).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()).catch(() => {})
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // GitHub API والملفات الخام: شبكة فقط — لا تخزين إطلاقاً
  if (url.hostname === 'api.github.com' || url.hostname === 'raw.githubusercontent.com') return;

  // ملفات التطبيق (نفس الأصل): الشبكة أولاً، والكاش احتياط دون إنترنت
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(V).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => caches.match(request).then((hit) => hit || (request.mode === 'navigate' ? caches.match('./index.html') : undefined)))
    );
    return;
  }

  // مكتبة fflate (CDN): الكاش أولاً مع تحديث خلفي — لتعمل دون إنترنت بعد أول تحميل
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.match(request).then((hit) => {
        const net = fetch(request).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(V).then((c) => c.put(request, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
  // أي أصل آخر: شبكة فقط
});
