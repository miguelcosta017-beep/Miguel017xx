/*
 * FISIO IF — service worker
 *
 * Atualizações são intencionalmente conservadoras: uma nova versão espera que
 * todas as janelas da versão anterior sejam fechadas antes de ativar. Isto evita
 * misturar HTML/JavaScript de versões diferentes durante uma sessão clínica.
 * Ao publicar alterações, mudar APP_VERSION.
 */

const APP_VERSION = "1.1.0";
const CACHE_PREFIX = "fisio-if-";
const CACHE_NAME = `${CACHE_PREFIX}app-${APP_VERSION}`;

const APP_SHELL = [
  "./index.html",
  "./offline.html",
  "./manifest.webmanifest",
  "./assets/css/styles.css",
  "./assets/js/app.js",
  "./assets/js/db.js",
  "./assets/js/backup.js",
  "./assets/js/excel.js",
  "./assets/icons/icon.svg",
];

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);

  // Guardar cada recurso separadamente torna o erro de instalação explícito e
  // evita respostas opacas ou páginas de erro dentro do cache da aplicação.
  await Promise.all(
    APP_SHELL.map(async (path) => {
      const request = new Request(path, { cache: "reload" });
      const response = await fetch(request);

      if (!response.ok || response.type === "opaque") {
        throw new Error(`Falha no pré-cache de ${path}: HTTP ${response.status}`);
      }

      await cache.put(request, response);
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheAppShell());
  // Não chamar skipWaiting() aqui: ver comentário sobre atualizações no topo.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

function isCacheableResponse(response) {
  return response && response.ok && response.type === "basic";
}

async function fetchWithTimeout(request, timeoutMs = 4500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleNavigation(request) {
  try {
    const response = await fetchWithTimeout(request);

    if (isCacheableResponse(response)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }

    return response;
  } catch {
    return (
      (await caches.match(request, { ignoreSearch: true })) ||
      (await caches.match("./index.html")) ||
      (await caches.match("./offline.html")) ||
      new Response("FISIO IF está offline e o conteúdo ainda não foi guardado.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      })
    );
  }
}

async function handleStaticAsset(request) {
  const cached = await caches.match(request, { ignoreSearch: true });

  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);

    if (isCacheableResponse(response)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }

    return response;
  } catch {
    return new Response("Recurso indisponível offline.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Ficheiros de backup/exportação nunca são tratados como recursos estáticos.
  if (url.pathname.endsWith(".json")) {
    return;
  }

  event.respondWith(handleStaticAsset(request));
});

// Permite que uma futura interface de atualização ative o worker apenas após
// consentimento explícito do utilizador.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});


