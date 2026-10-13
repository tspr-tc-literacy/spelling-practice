// Service worker for the Spelling Practice App (v3).
const CACHE = 'spelling-app-v3.0.5';
// CACHE holds the page and is renamed every release: 'spelling-app-v' followed
// by CONFIG.VERSION, which tools/publish_release.py checks, so an installed
// app fetches the new page instead of serving the old one.
// Voice clips: their own cache, NOT versioned with the app. An app update must
// never throw away audio a family has already downloaded. Same name as Voice's
// CACHE (audio.js), and the same name 2.x used, so the move to v3 kept every
// downloaded clip.
// 3.0.1: a clip that CHANGES reaches phones by its address, not by renaming
// this cache. The page asks for audio/w/<word>.mp3?h=<the first 8 hex of the
// clip's sha256> (the manifest's `hashes`, written by compile.py), so a
// re-recorded clip is a new address: it is not in this cache and not in the
// browser's own 10-minute copy (GitHub Pages sends max-age=600), so it is
// fetched fresh and kept under its new address. Nothing else is fetched again.
// The entries under the old addresses (2.x and 3.0.0 asked for the plain
// audio/w/<word>.mp3) are left where they are: small, harmless, never asked
// for again, so there is no sweep to get wrong.
const AUDIO_CACHE = 'spelling-audio-v1';
const ASSETS = ['./', './index.html', './manifest.webmanifest'];

// Install from the NETWORK, bypassing the browser's HTTP cache. GitHub Pages
// sends max-age=600, so a plain addAll() can store a still-cached copy of the OLD
// page under this new version's name, and the phone would then keep serving the
// old app until the next release. (found in review, 2026-09-15)
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c =>
    c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

// Which caches activate deletes: every cache except this version's page and
// the audio. That clears the 2.x app's page caches, 3.0.0's page cache and any
// cache the v3 trial build left behind, while the voice clips stay. (Decided
// 2026-10-09.)
function staleCaches(keys) {
  return keys.filter(k => k !== CACHE && k !== AUDIO_CACHE);
}

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      staleCaches(keys).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// Safari's audio player asks for byte RANGES and expects a 206 partial response.
// Answering a ranged request with the whole cached 200 file can make it refuse
// the clip - which would silently send every word on an iPhone to the phone's
// own voice. So a ranged request gets exactly the requested slice.
// Pure (no service-worker globals), so it is tested in Node.
function rangedResponse(buf, rangeHeader, type) {
  const total = buf.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {                      // suffix range: the last N bytes
    const n = Math.min(parseInt(m[2], 10), total);
    start = total - n;
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
  }
  if (!(start >= 0) || start > end || start >= total) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': type || 'audio/mpeg',
      'Content-Length': String(end - start + 1),
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Accept-Ranges': 'bytes'
    }
  });
}

async function audioResponse(request) {
  const range = request.headers.get('range');
  // Keyed on the full URL, ?h=<hash> included (so a changed clip is a new
  // entry), and on the URL alone: a Range header must not change which entry
  // matches.
  let hit = await caches.match(request.url);
  if (!hit) {
    try {
      // Fetch the WHOLE file, without the Range, so it can be kept - a 206
      // partial response cannot be stored.
      const full = await fetch(request.url);
      if (!(full && full.ok && full.status === 200)) return full;
      const copy = full.clone();
      caches.open(AUDIO_CACHE).then(c => c.put(request.url, copy)).catch(() => {});
      hit = full;
    } catch (e) {
      return fetch(request);             // offline and not cached: fail normally
    }
  }
  if (!range) return hit;
  const buf = await hit.clone().arrayBuffer();
  return rangedResponse(buf, range, hit.headers.get('Content-Type')) || hit;
}

self.addEventListener('fetch', e => {
  if (e.request.url.indexOf('/audio/') !== -1) {
    e.respondWith(audioResponse(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true })
      .then(hit => hit || fetch(e.request))
  );
});
