// ================== SERVICE WORKER - KABAS MEAN (OFFLINE PWA) ==================
// Tujuan: agar halaman utama (termasuk seluruh konten FAQ, Hak Akses, dan panduan
// yang datanya sudah tertanam di file HTML) tetap bisa dibuka tanpa koneksi internet
// setelah pernah dibuka minimal sekali secara online.
//
// Strategi:
// - Dokumen HTML (navigasi)  -> Network First, fallback ke cache saat offline.
// - Aset pendukung (CDN JS/CSS, ikon, manifest) -> Cache First, lalu di-refresh
//   di belakang layar (stale-while-revalidate) supaya tetap up to date saat online.
// - Fitur yang butuh server aktif (Live Chat, Login Admin, kirim Evaluasi) TIDAK
//   bisa berfungsi saat offline karena butuh Supabase — ini normal dan sudah
//   ditangani dengan pengecekan koneksi di kode utama (showToast peringatan).

const CACHE_VERSION = 'v1';
const CACHE_NAME = 'kabasmean-cache-' + CACHE_VERSION;

// './' merujuk ke halaman HTML utama tempat sw.js didaftarkan (mis. index.html).
const APP_SHELL = [
  './',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

// CDN pihak ketiga yang dipakai halaman utama. Di-precache dengan mode 'no-cors'
// (opaque response) supaya tetap tersimpan walau server CDN tidak mengirim header CORS.
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Inter:wght@300;400;500;600;700;800&display=swap',
  'https://unpkg.com/lucide@latest',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js',
  'https://raw.githubusercontent.com/kabasmean/SRIKANDI/refs/heads/main/images/logo/Kabasmean.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Aset satu origin (bisa gagal individual tanpa membatalkan instalasi semua).
      await Promise.allSettled(
        APP_SHELL.map(async (url) => {
          try {
            const res = await fetch(url, { cache: 'no-cache' });
            if (res.ok) await cache.put(url, res);
          } catch (e) { /* aset opsional, abaikan jika gagal */ }
        })
      );

      // Aset CDN lintas origin.
      await Promise.allSettled(
        CDN_ASSETS.map(async (url) => {
          try {
            const res = await fetch(url, { mode: 'no-cors', cache: 'no-cache' });
            await cache.put(url, res);
          } catch (e) { /* offline saat install pertama, abaikan */ }
        })
      );

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isNavigationRequest(request) {
  return request.mode === 'navigate' ||
    (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Hanya tangani GET; biarkan request Supabase/EmailJS (POST, dsb) lewat apa adanya.
  if (request.method !== 'GET') return;

  // Jangan campuri panggilan API Supabase/EmailJS — biar gagal wajar saat offline
  // supaya kode utama bisa menampilkan pesan "belum terkonfigurasi/offline" sendiri.
  const url = new URL(request.url);
  if (url.hostname.includes('supabase.co') || url.hostname.includes('emailjs.com')) {
    return;
  }

  if (isNavigationRequest(request)) {
    // Network First untuk dokumen HTML agar update terbaru selalu diprioritaskan saat online.
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put('./', fresh.clone());
          return fresh;
        } catch (e) {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match('./');
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  // Cache First + Stale-While-Revalidate untuk aset statis (CDN, ikon, manifest).
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request, { ignoreVary: true });

      const networkFetch = fetch(request.mode === 'no-cors' ? request : request)
        .then((res) => {
          cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) {
        // Refresh di latar belakang, tidak menunggu (stale-while-revalidate).
        event.waitUntil(networkFetch);
        return cached;
      }

      const fresh = await networkFetch;
      return fresh || Response.error();
    })()
  );
});
