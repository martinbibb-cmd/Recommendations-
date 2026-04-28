/* sw.js – Survey Brain Floor Planner service worker */
const CACHE = 'sb-fp-v1';
const PRECACHE = [
  '/floorplan.html',
  '/floorplan.js',
  '/manifest.json',
  '/index.html',
  '/recommend.js',
  'https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css',
  'https://cdn.jsdelivr.net/npm/three@0.166.0/build/three.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => {
      // Cache critical app shell; ignore CDN failures in dev
      return Promise.allSettled(PRECACHE.map(url => cache.add(url)));
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  // Handle share-target POST (inbound LiDAR file)
  if (request.method === 'POST' && new URL(request.url).pathname === '/floorplan.html') {
    event.respondWith(
      (async () => {
        const formData = await request.formData();
        const file = formData.get('scan');
        if (file) {
          // Store file in cache under a known key for the page to read
          const cache = await caches.open(CACHE);
          const buf   = await file.arrayBuffer();
          await cache.put(
            '/shared-scan',
            new Response(buf, {
              headers: {
                'Content-Type': file.type || 'application/octet-stream',
                'X-File-Name': file.name
              }
            })
          );
        }
        return Response.redirect('/floorplan.html?shared=1', 303);
      })()
    );
    return;
  }

  // Network-first for API calls
  if (request.url.includes('workers.dev')) {
    event.respondWith(fetch(request).catch(() => new Response('Offline', { status: 503 })));
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      }).catch(() => cached || new Response('Offline', { status: 503 }));
    })
  );
});
