// Bump this version to invalidate the old cache and re-fetch all assets.
const CACHE_VERSION = 'v1';
const CACHE_NAME = `friends-slay-aliens-${CACHE_VERSION}`;

const PRECACHE_ASSETS = [
  '/',
  '/game.js',
  '/game.css',
  '/favicon.ico',
  '/manifest.json',
  '/assets/backgrounds/redplanet_layer01.png',
  '/assets/backgrounds/redplanet_layer02.png',
  '/assets/backgrounds/redplanet_layer03.png',
  '/assets/backgrounds/redplanet_layer04.png',
  '/assets/character/boy_01.png',
  '/assets/character/boy_02.png',
  '/assets/character/boy_03.png',
  '/assets/character/boy_04.png',
  '/assets/character/boy_05.png',
  '/assets/character/boy_06.png',
  '/assets/enemies/alien_01.png',
  '/assets/enemies/alien_02.png',
  '/assets/enemies/alien_03.png',
  '/assets/game_title.png',
  '/assets/icon.png',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/music/game_loop.mp3',
  '/assets/music/title_loop.mp3',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const ext = url.pathname.split('.').pop().toLowerCase();

  if (ext === 'mp3' || ext === 'ogg' || ext === 'wav') {
    event.respondWith(handleAudio(event.request));
  } else if (ext === 'html' || ext === 'js' || ext === 'css' || url.pathname === '/') {
    event.respondWith(networkFirst(event.request));
  } else {
    event.respondWith(cacheFirst(event.request));
  }
});

// Try network, update cache, fall back to cache if offline.
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached ?? new Response('Offline — no cached version available.', { status: 503 });
  }
}

// Serve from cache immediately; fall back to network and populate cache.
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — asset not cached.', { status: 503 });
  }
}

// Audio needs special handling: browsers often send Range requests for seeking.
// We serve from cache where possible and synthesize a proper 206 response so
// that the Audio element doesn't stall waiting for partial-content support.
async function handleAudio(request) {
  const rangeHeader = request.headers.get('range');

  // Try to find a cached full response regardless of the Range header.
  const cached = await caches.match(new Request(request.url));

  if (cached) {
    if (rangeHeader) {
      return buildRangeResponse(cached, rangeHeader);
    }
    return cached;
  }

  // Not cached — fetch from network.
  try {
    // Fetch the full file so we can cache it (strip Range header for pre-caching).
    const fullResponse = await fetch(new Request(request.url));
    if (fullResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(new Request(request.url), fullResponse.clone());
      if (rangeHeader) {
        return buildRangeResponse(fullResponse, rangeHeader);
      }
    }
    return fullResponse;
  } catch {
    return new Response('Offline — audio not cached.', { status: 503 });
  }
}

async function buildRangeResponse(response, rangeHeader) {
  const body = await response.arrayBuffer();
  const total = body.byteLength;
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
  if (!match) return new Response(body, { status: 200, headers: response.headers });

  const start = Number(match[1]);
  const end = match[2] !== '' ? Number(match[2]) : total - 1;
  const sliced = body.slice(start, end + 1);

  return new Response(sliced, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(sliced.byteLength),
      'Content-Type': response.headers.get('Content-Type') ?? 'audio/mpeg',
    },
  });
}
