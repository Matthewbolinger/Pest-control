const CACHE_PREFIX = "fieldproof-public-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const LEGACY_CACHE_PREFIXES = ["fieldproof-shell-"];
const JOURNAL_DATABASES = [
  "fieldproof-offline-journal",
  "fieldproof-offline",
];
const BUILD_KEY = "/__fieldproof_public_build_sha__";
const PRECACHE_ASSETS = ["/manifest.webmanifest", "/favicon.svg"];
const PUBLIC_STATIC_PREFIXES = ["/_next/static/"];
const AUTH_PATHS = new Set([
  "/signin-with-chatgpt",
  "/signout-with-chatgpt",
  "/callback",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    removeOldFieldProofCaches().then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "FIELDPROOF_SET_BUILD") {
    event.waitUntil(
      Promise.resolve()
        .then(() => setPublicBuild(requireBuildSha(event.data.buildSha)))
        .then((buildSha) => {
          event.ports[0]?.postMessage({ ok: true, buildSha });
        })
        .catch((error) => {
          event.ports[0]?.postMessage({
            ok: false,
            error: error instanceof Error ? error.message : "Cache update failed.",
          });
          throw error;
        }),
    );
    return;
  }

  if (event.data?.type === "FIELDPROOF_PURGE_PRIVATE_DATA") {
    event.waitUntil(
      purgePrivateDeviceState({
        databasesCleared: event.data.databasesCleared === true,
      })
        .then(() => caches.open(CACHE_NAME))
        .then((cache) => cache.addAll(PRECACHE_ASSETS))
        .then(() => {
          event.ports[0]?.postMessage({ ok: true });
        })
        .catch((error) => {
          event.ports[0]?.postMessage({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Private device data purge failed.",
          });
          throw error;
        }),
    );
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isSignOut(url.pathname)) {
    event.respondWith(handlePrivateAuthTransition(request));
    return;
  }
  if (isAuthEntry(url.pathname)) {
    event.respondWith(handlePrivateAuthTransition(request));
    return;
  }
  if (isNetworkOnly(url.pathname)) {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkOnlyNavigation(request));
    return;
  }
  if (isAllowlistedPublicAsset(url.pathname)) {
    event.respondWith(cacheFirstPublicAsset(request));
  }
});

async function setPublicBuild(buildSha) {
  let cache = await caches.open(CACHE_NAME);
  const priorBuild = await cache.match(BUILD_KEY);
  const priorBuildSha = priorBuild ? await priorBuild.text() : null;
  if (priorBuildSha !== buildSha) {
    await removeAllFieldProofCaches();
    cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_ASSETS);
    await cache.put(
      BUILD_KEY,
      new Response(buildSha, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      }),
    );
  }
  return buildSha;
}

async function networkOnlyNavigation(request) {
  try {
    // Personalized SSR/RSC HTML is never written to Cache Storage.
    return await fetch(request, { cache: "no-store" });
  } catch {
    return offlineResponse();
  }
}

async function cacheFirstPublicAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (
    response.ok &&
    !response.redirected &&
    (response.type === "basic" || response.type === "default")
  ) {
    await cache.put(request, response.clone());
  }
  return response;
}

function isNetworkOnly(pathname) {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    AUTH_PATHS.has(pathname) ||
    pathname.startsWith("/signin-with-chatgpt/") ||
    pathname.startsWith("/signout-with-chatgpt/") ||
    pathname.startsWith("/callback/")
  );
}

function isSignOut(pathname) {
  return (
    pathname === "/signout-with-chatgpt" ||
    pathname.startsWith("/signout-with-chatgpt/")
  );
}

function isAuthEntry(pathname) {
  return (
    pathname === "/signin-with-chatgpt" ||
    pathname.startsWith("/signin-with-chatgpt/") ||
    pathname === "/callback" ||
    pathname.startsWith("/callback/")
  );
}

function isAllowlistedPublicAsset(pathname) {
  return (
    PRECACHE_ASSETS.includes(pathname) ||
    PUBLIC_STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

async function removeOldFieldProofCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter(
        (key) =>
          (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) ||
          LEGACY_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)),
      )
      .map((key) => deleteCacheStrictly(key)),
  );
}

async function removeAllFieldProofCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter(
        (key) =>
          key.startsWith(CACHE_PREFIX) ||
          LEGACY_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)),
      )
      .map((key) => deleteCacheStrictly(key)),
  );
}

async function deleteCacheStrictly(key) {
  const deleted = await caches.delete(key);
  if (deleted) return;
  if ((await caches.keys()).includes(key)) {
    throw new Error(`Cache ${key} could not be deleted.`);
  }
}

async function purgePrivateDeviceState({ databasesCleared = false } = {}) {
  await Promise.all([
    removeAllFieldProofCaches(),
    ...(databasesCleared
      ? []
      : JOURNAL_DATABASES.map((databaseName) =>
          clearDatabaseStores(databaseName),
        )),
  ]);
}

async function handlePrivateAuthTransition(request) {
  try {
    await purgePrivateDeviceState();
    return await fetch(request, { cache: "no-store" });
  } catch (error) {
    return privacyPurgeFailureResponse(error);
  }
}

function clearDatabaseStores(databaseName) {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) {
      resolve();
      return;
    }
    let settled = false;
    let database = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      database?.close();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            `Clearing ${databaseName} timed out because another app context may be upgrading it.`,
          ),
        ),
      4_000,
    );
    let request;
    try {
      request = self.indexedDB.open(databaseName);
    } catch (error) {
      finish(
        error instanceof Error
          ? error
          : new Error(`Opening ${databaseName} failed.`),
      );
      return;
    }
    request.onerror = () =>
      finish(
        request.error ??
          new Error(`Opening ${databaseName} for privacy purge failed.`),
      );
    request.onblocked = () => undefined;
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      database = request.result;
      const storeNames = Array.from(database.objectStoreNames);
      if (storeNames.length === 0) {
        finish();
        return;
      }
      let transaction;
      try {
        transaction = database.transaction(storeNames, "readwrite");
        for (const storeName of storeNames) {
          transaction.objectStore(storeName).clear();
        }
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error(`Clearing ${databaseName} failed.`),
        );
        return;
      }
      transaction.oncomplete = () => finish();
      transaction.onerror = () =>
        finish(
          transaction.error ??
            new Error(`Clearing ${databaseName} failed.`),
        );
      transaction.onabort = () =>
        finish(
          transaction.error ??
            new Error(`Clearing ${databaseName} was aborted.`),
        );
    };
  });
}

function requireBuildSha(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(value) ||
    value === "unknown" ||
    value === "unverified"
  ) {
    throw new Error("This build has no verified source revision.");
  }
  return value;
}

function privacyPurgeFailureResponse(error) {
  const message =
    error instanceof Error ? error.message : "Private device data purge failed.";
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FieldProof privacy lock</title></head><body><main><h1>Sign-in transition paused</h1><p>FieldProof could not verify that private offline data was cleared. Close other FieldProof tabs and try again.</p><p>${escapeHtml(message)}</p></main></body></html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

function offlineResponse() {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#123c2e">
  <title>FieldProof · Offline</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f4f0;color:#17221d;font:16px system-ui,sans-serif}
    main{max-width:34rem;padding:2rem;text-align:center}
    strong{display:block;font-size:1.75rem;margin-bottom:.75rem}
    p{color:#68756e;line-height:1.5}
  </style>
</head>
<body><main><strong>FieldProof is offline</strong><p>Your queued work stays on this device. Reconnect to securely return to the signed-in application.</p></main></body>
</html>`,
    {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
