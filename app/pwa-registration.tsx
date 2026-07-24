"use client";

import { useEffect } from "react";
import {
  journalScopeKey,
  OfflineJournalStore,
  type ActorScope,
  type AppendJournalOperation,
  type JournalScope,
} from "../packages/client/offline-store";
import {
  createFieldProofHttpTransport,
  OfflineSyncExecutor,
  type ReplayExecutionResult,
} from "../packages/client/sync-engine";

type PwaStatus =
  | "unsupported"
  | "registering"
  | "ready"
  | "update-found"
  | "error";

type RuntimeResult =
  | Readonly<{
      requestId?: string;
      ok: true;
      value?: unknown;
    }>
  | Readonly<{
      requestId?: string;
      ok: false;
      error: string;
    }>;

type ActorIdentityResolution =
  | Readonly<{ state: "AUTHENTICATED"; actor: ActorScope }>
  | Readonly<{ state: "SIGNED_OUT" }>
  | Readonly<{ state: "UNVERIFIED"; error: string }>;

export function PwaRegistration() {
  useEffect(() => {
    if (
      !("serviceWorker" in navigator) ||
      !(window.isSecureContext || isLoopback(window.location.hostname))
    ) {
      emitStatus("unsupported");
      return;
    }

    let cancelled = false;
    let registration: ServiceWorkerRegistration | null = null;
    let journal: OfflineJournalStore | null = null;
    let removeRuntimeListeners: (() => void) | null = null;

    async function register() {
      emitStatus("registering");
      try {
        registration = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        if (cancelled) return;
        registration.addEventListener("updatefound", () => {
          emitStatus("update-found");
        });
        await registration.update();
        const readyRegistration = await navigator.serviceWorker.ready;
        if (cancelled) return;

        const cacheResult = await sendWorkerMessage(readyRegistration, {
          type: "FIELDPROOF_SET_BUILD",
          buildSha: buildShaFromDocument(),
        });
        if (!cacheResult.ok) {
          throw new Error(cacheResult.error ?? "Public shell caching failed.");
        }

        journal = await OfflineJournalStore.open();
        if (cancelled) {
          journal.close();
          journal = null;
          return;
        }
        const identity = await resolveActorIdentity();
        if (identity.state === "SIGNED_OUT") {
          await purgeLocalPrivateData(journal, readyRegistration);
        }
        removeRuntimeListeners = installJournalRuntime(
          journal,
          readyRegistration,
          identity,
        );
        if (identity.state === "UNVERIFIED") {
          emitRuntimeResult({
            ok: false,
            error: identity.error,
          });
          emitStatus("error");
        } else {
          emitStatus("ready");
        }
        emitSyncWakeup("service-worker-ready");
      } catch {
        if (!cancelled) emitStatus("error");
      }
    }

    function refreshWhenVisible() {
      if (document.visibilityState !== "visible" || !registration) return;
      void registration.update().then(
        async () => {
          if (!registration) return;
          await sendWorkerMessage(registration, {
            type: "FIELDPROOF_SET_BUILD",
            buildSha: buildShaFromDocument(),
          });
          emitSyncWakeup("visible");
        },
        () => undefined,
      );
    }

    function wakeWhenOnline() {
      emitSyncWakeup("online");
    }

    void register();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("online", wakeWhenOnline);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("online", wakeWhenOnline);
      removeRuntimeListeners?.();
      journal?.close();
    };
  }, []);

  return null;
}

function installJournalRuntime(
  store: OfflineJournalStore,
  registration: ServiceWorkerRegistration,
  initialIdentity: ActorIdentityResolution,
) {
  const executor = new OfflineSyncExecutor(
    store,
    createFieldProofHttpTransport(),
  );
  const knownScopes = new Map<string, JournalScope>();
  const retryTimers = new Map<string, number>();
  let actorScope =
    initialIdentity.state === "AUTHENTICATED"
      ? initialIdentity.actor
      : null;
  let identityLocked = initialIdentity.state === "UNVERIFIED";
  const retryHeartbeat = window.setInterval(() => {
    if (document.visibilityState === "visible" && navigator.onLine) {
      emitSyncWakeup("retry-due");
    }
  }, 30_000);

  function assertAuthorizedScope(scope: JournalScope) {
    if (identityLocked) {
      throw new Error(
        "Offline work is locked until the authenticated membership is verified.",
      );
    }
    if (
      !actorScope ||
      scope.organizationId !== actorScope.organizationId ||
      scope.actorId.toLowerCase() !== actorScope.actorId.toLowerCase()
    ) {
      throw new Error(
        "The journal scope does not match the authenticated membership.",
      );
    }
  }

  function rememberScope(scope: JournalScope) {
    assertAuthorizedScope(scope);
    knownScopes.set(journalScopeKey(scope), scope);
  }

  async function refreshIdentity() {
    identityLocked = true;
    const resolution = await resolveActorIdentity();
    if (resolution.state === "UNVERIFIED") {
      throw new Error(resolution.error);
    }
    const resolved =
      resolution.state === "AUTHENTICATED"
        ? resolution.actor
        : null;
    if (
      actorScope &&
      resolved &&
      actorScope.organizationId === resolved.organizationId &&
      actorScope.actorId.toLowerCase() === resolved.actorId.toLowerCase()
    ) {
      actorScope = resolved;
      identityLocked = false;
      return;
    }

    if (!actorScope && !resolved) {
      identityLocked = false;
      return;
    }

    // Keep the prior actor in memory and the runtime locked until every
    // private-data boundary confirms its purge.
    await purgeLocalPrivateData(store, registration);
    clearRetryTimers(retryTimers);
    knownScopes.clear();
    actorScope = resolved;
    identityLocked = false;
  }

  async function replayScope(
    scope: JournalScope,
    knownServerVersion?: number,
  ) {
    rememberScope(scope);
    const serverVersion =
      knownServerVersion ?? (await fetchWorkflowVersion(scope));
    const result = await withScopeLock(scope, () =>
      executor.replay(scope, serverVersion),
    );
    scheduleDeferredRetry(scope, result);
    return result;
  }

  function scheduleDeferredRetry(
    scope: JournalScope,
    result: ReplayExecutionResult,
  ) {
    const scopeKey = journalScopeKey(scope);
    const existing = retryTimers.get(scopeKey);
    if (existing !== undefined) window.clearTimeout(existing);
    retryTimers.delete(scopeKey);
    const retryAt = result.plan.deferred.reduce<number | null>(
      (earliest, item) =>
        earliest === null || item.retryAt < earliest
          ? item.retryAt
          : earliest,
      null,
    );
    if (retryAt === null) return;
    const timer = window.setTimeout(() => {
      retryTimers.delete(scopeKey);
      void replayScope(scope).then(
        (value) =>
          emitRuntimeResult({
            ok: true,
            value,
          }),
        (error) =>
          emitRuntimeResult({
            ok: false,
            error: errorMessage(error),
          }),
      );
    }, Math.max(0, retryAt - Date.now()));
    retryTimers.set(scopeKey, timer);
  }

  const onAppend = (event: Event) => {
    const detail = (
      event as CustomEvent<{
        requestId?: string;
        input: AppendJournalOperation;
      }>
    ).detail;
    if (!detail?.input) return;
    void (async () => {
      try {
        rememberScope(detail.input.scope);
        const operation = await store.append(detail.input);
        emitRuntimeResult({
          requestId: detail.requestId,
          ok: true,
          value: operation,
        });
        if (navigator.onLine) {
          void replayScope(operation.scope).catch((error) => {
            emitRuntimeResult({
              ok: false,
              error: errorMessage(error),
            });
          });
        }
      } catch (error) {
        emitRuntimeResult({
          requestId: detail.requestId,
          ok: false,
          error: errorMessage(error),
        });
      }
    })();
  };

  const onSync = (event: Event) => {
    const detail = (
      event as CustomEvent<{
        requestId?: string;
        scope: JournalScope;
        serverVersion: number;
      }>
    ).detail;
    if (!detail?.scope) return;
    void replayScope(detail.scope, detail.serverVersion).then(
      (result) =>
        emitRuntimeResult({
          requestId: detail.requestId,
          ok: true,
          value: result,
        }),
      (error) =>
        emitRuntimeResult({
          requestId: detail.requestId,
          ok: false,
          error: errorMessage(error),
        }),
    );
  };

  const onResume = (event: Event) => {
    const detail = (
      event as CustomEvent<{
        requestId?: string;
        scope: JournalScope;
        operationId: string;
        expectedRevision: number;
      }>
    ).detail;
    if (!detail?.scope) return;
    void (async () => {
      try {
        await refreshIdentity();
        rememberScope(detail.scope);
        const operation = await store.resumeBlocked(
          detail.scope,
          detail.operationId,
          {
            expectedRevision: detail.expectedRevision,
            now: Date.now(),
          },
        );
        const replay =
          operation && navigator.onLine
            ? await replayScope(operation.scope)
            : null;
        emitRuntimeResult({
          requestId: detail.requestId,
          ok: true,
          value: { operation, replay },
        });
      } catch (error) {
        emitRuntimeResult({
          requestId: detail.requestId,
          ok: false,
          error: errorMessage(error),
        });
      }
    })();
  };

  const onDiscard = (event: Event) => {
    const detail = (
      event as CustomEvent<{
        requestId?: string;
        scope: JournalScope;
        operationId: string;
        expectedRevision: number;
      }>
    ).detail;
    if (!detail?.scope) return;
    void (async () => {
      try {
        await refreshIdentity();
        rememberScope(detail.scope);
        const operations = await store.discardBlockedCascade(
          detail.scope,
          detail.operationId,
          {
            expectedRevision: detail.expectedRevision,
            now: Date.now(),
          },
        );
        if (!operations) {
          throw new Error(
            "The blocked operation changed before it could be discarded.",
          );
        }
        const scopeKey = journalScopeKey(detail.scope);
        const timer = retryTimers.get(scopeKey);
        if (timer !== undefined) window.clearTimeout(timer);
        retryTimers.delete(scopeKey);
        emitRuntimeResult({
          requestId: detail.requestId,
          ok: true,
          value: operations,
        });
      } catch (error) {
        emitRuntimeResult({
          requestId: detail.requestId,
          ok: false,
          error: errorMessage(error),
        });
      }
    })();
  };

  const onPurge = (event: Event) => {
    const detail = (
      event as CustomEvent<{
        requestId?: string;
        actor?: ActorScope;
        all?: boolean;
      }>
    ).detail;
    if (!detail) return;
    if (detail.actor && !detail.all) {
      if (
        !actorScope ||
        detail.actor.organizationId !== actorScope.organizationId ||
        detail.actor.actorId.toLowerCase() !==
          actorScope.actorId.toLowerCase()
      ) {
        emitRuntimeResult({
          requestId: detail.requestId,
          ok: false,
          error: "Purge scope does not match the authenticated membership.",
        });
        return;
      }
    }
    const priorLock = identityLocked;
    identityLocked = true;
    const scopedPurge = detail.all
      ? purgeLocalPrivateData(store, registration)
      : detail.actor
        ? purgeActorPrivateData(store, registration, detail.actor)
        : Promise.reject(new Error("An actor scope is required for purge."));
    void scopedPurge
      .then(
        () => {
          clearRetryTimers(retryTimers);
          knownScopes.clear();
          identityLocked = priorLock;
          emitRuntimeResult({
            requestId: detail.requestId,
            ok: true,
          });
        },
        (error) => {
          identityLocked = true;
          emitRuntimeResult({
            requestId: detail.requestId,
            ok: false,
            error: errorMessage(error),
          });
        },
      );
  };

  const onSyncWakeup = () => {
    void (async () => {
      await refreshIdentity();
      if (!actorScope || !navigator.onLine) return;
      if (knownScopes.size === 0) {
        const discovered = await discoverWorkflowScope(actorScope);
        if (discovered) {
          rememberScope(discovered.scope);
          await replayScope(discovered.scope, discovered.serverVersion);
        }
        return;
      }
      for (const scope of knownScopes.values()) {
        if (
          scope.organizationId === actorScope.organizationId &&
          scope.actorId.toLowerCase() === actorScope.actorId.toLowerCase()
        ) {
          void replayScope(scope);
        }
      }
    })().catch((error) => {
      emitRuntimeResult({ ok: false, error: errorMessage(error) });
    });
  };

  const onDocumentClick = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const target = event.target;
    const anchor =
      target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
    if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) {
      return;
    }
    const destination = new URL(anchor.href, window.location.href);
    if (
      destination.origin !== window.location.origin ||
      destination.pathname !== "/signout-with-chatgpt"
    ) {
      return;
    }
    event.preventDefault();
    identityLocked = true;
    void purgeLocalPrivateData(store, registration).then(
      () => {
        actorScope = null;
        clearRetryTimers(retryTimers);
        knownScopes.clear();
        window.location.assign(destination.href);
      },
      (error) => {
        emitRuntimeResult({
          ok: false,
          error: `Sign-out was stopped because private device data could not be cleared: ${errorMessage(error)}`,
        });
      },
    );
  };

  window.addEventListener("fieldproof:journal-append", onAppend);
  window.addEventListener("fieldproof:journal-sync", onSync);
  window.addEventListener("fieldproof:journal-resume", onResume);
  window.addEventListener("fieldproof:journal-discard", onDiscard);
  window.addEventListener("fieldproof:journal-purge", onPurge);
  window.addEventListener("fieldproof:sync-wakeup", onSyncWakeup);
  document.addEventListener("click", onDocumentClick, true);
  window.dispatchEvent(new CustomEvent("fieldproof:journal-ready"));

  return () => {
    window.removeEventListener("fieldproof:journal-append", onAppend);
    window.removeEventListener("fieldproof:journal-sync", onSync);
    window.removeEventListener("fieldproof:journal-resume", onResume);
    window.removeEventListener("fieldproof:journal-discard", onDiscard);
    window.removeEventListener("fieldproof:journal-purge", onPurge);
    window.removeEventListener("fieldproof:sync-wakeup", onSyncWakeup);
    document.removeEventListener("click", onDocumentClick, true);
    clearRetryTimers(retryTimers);
    window.clearInterval(retryHeartbeat);
  };
}

function clearRetryTimers(timers: ReadonlyMap<string, number>) {
  for (const timer of timers.values()) window.clearTimeout(timer);
  if (timers instanceof Map) timers.clear();
}

async function fetchWorkflowVersion(scope: JournalScope) {
  const response = await fetch("/api/v1/workflow", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const body = (await response.json().catch(() => null)) as {
    data?: { jobId?: unknown; version?: unknown };
    error?: { message?: unknown };
  } | null;
  if (!response.ok) {
    throw new Error(
      typeof body?.error?.message === "string"
        ? body.error.message
        : "The authoritative workflow version is unavailable.",
    );
  }
  if (
    body?.data?.jobId !== scope.jobId ||
    !Number.isInteger(body.data.version) ||
    Number(body.data.version) < 1
  ) {
    throw new Error("The workflow response does not match the journal scope.");
  }
  return Number(body.data.version);
}

async function discoverWorkflowScope(
  actor: ActorScope,
): Promise<{ scope: JournalScope; serverVersion: number } | null> {
  try {
    const response = await fetch("/api/v1/workflow", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data?: { jobId?: unknown; version?: unknown };
    };
    if (
      typeof body.data?.jobId !== "string" ||
      !body.data.jobId.trim() ||
      !Number.isInteger(body.data.version) ||
      Number(body.data.version) < 1
    ) {
      return null;
    }
    return {
      scope: {
        organizationId: actor.organizationId,
        actorId: actor.actorId,
        jobId: body.data.jobId.trim(),
      },
      serverVersion: Number(body.data.version),
    };
  } catch {
    return null;
  }
}

async function resolveActorIdentity(): Promise<ActorIdentityResolution> {
  try {
    const response = await fetch("/api/v1/me", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) {
      return { state: "SIGNED_OUT" };
    }
    if (!response.ok) {
      return {
        state: "UNVERIFIED",
        error: `Membership verification failed with HTTP ${response.status}.`,
      };
    }
    const body = (await response.json()) as {
      data?: {
        user?: { id?: unknown };
        membership?: { organizationId?: unknown };
      };
    };
    const actorId = body.data?.user?.id;
    const organizationId = body.data?.membership?.organizationId;
    return typeof actorId === "string" &&
      actorId.trim() &&
      typeof organizationId === "string" &&
      organizationId.trim()
      ? {
          state: "AUTHENTICATED",
          actor: {
            actorId: actorId.trim().toLowerCase(),
            organizationId: organizationId.trim(),
          },
        }
      : {
          state: "UNVERIFIED",
          error: "The membership response did not identify an actor and organization.",
        };
  } catch (error) {
    return {
      state: "UNVERIFIED",
      error: `Membership verification is unavailable: ${errorMessage(error)}`,
    };
  }
}

async function withScopeLock<T>(
  scope: JournalScope,
  run: () => Promise<T>,
): Promise<T> {
  const lockManager = navigator.locks;
  if (!lockManager) return run();
  const name = `fieldproof-sync:${JSON.stringify([
    scope.organizationId,
    scope.actorId.toLowerCase(),
    scope.jobId,
  ])}`;
  return lockManager.request(name, { mode: "exclusive" }, run);
}

function sendWorkerMessage(
  registration: ServiceWorkerRegistration,
  message: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const worker =
    registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) {
    return Promise.resolve({
      ok: false,
      error: "No active service worker is available.",
    });
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      channel.port1.close();
      resolve({ ok: false, error: "Service worker acknowledgement timed out." });
    }, 5_000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      const data = event.data;
      resolve(
        data && typeof data === "object" && data.ok === true
          ? { ok: true }
          : {
              ok: false,
              error:
                data && typeof data.error === "string"
                  ? data.error
                  : "Service worker operation failed.",
            },
      );
    };
    worker.postMessage(message, [channel.port2]);
  });
}

function buildShaFromDocument() {
  const value = document.documentElement.dataset.buildSha;
  return value && /^[A-Za-z0-9._-]{1,64}$/.test(value)
    ? value
    : "unverified";
}

function emitStatus(status: PwaStatus) {
  window.dispatchEvent(
    new CustomEvent("fieldproof:pwa-status", {
      detail: { status },
    }),
  );
}

function emitSyncWakeup(
  reason: "service-worker-ready" | "online" | "visible" | "retry-due",
) {
  window.dispatchEvent(
    new CustomEvent("fieldproof:sync-wakeup", {
      detail: { reason, at: Date.now() },
    }),
  );
}

function emitRuntimeResult(result: RuntimeResult) {
  window.dispatchEvent(
    new CustomEvent("fieldproof:journal-result", { detail: result }),
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Offline operation failed.";
}

async function purgeLocalPrivateData(
  store: OfflineJournalStore,
  registration: ServiceWorkerRegistration,
) {
  await Promise.all([store.clearAll(), deleteLegacyOfflineData()]);
  await requireWorkerAcknowledgement(
    sendWorkerMessage(registration, {
      type: "FIELDPROOF_PURGE_PRIVATE_DATA",
      databasesCleared: true,
    }),
  );
}

async function purgeActorPrivateData(
  store: OfflineJournalStore,
  registration: ServiceWorkerRegistration,
  actor: ActorScope,
) {
  await Promise.all([store.clearActor(actor), deleteLegacyOfflineData()]);
  await requireWorkerAcknowledgement(
    sendWorkerMessage(registration, {
      type: "FIELDPROOF_PURGE_PRIVATE_DATA",
      databasesCleared: true,
    }),
  );
}

async function requireWorkerAcknowledgement(
  result: Promise<{ ok: boolean; error?: string }>,
) {
  const acknowledgement = await result;
  if (!acknowledgement.ok) {
    throw new Error(
      acknowledgement.error ?? "Service worker privacy purge failed.",
    );
  }
}

function deleteLegacyOfflineData() {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = window.setTimeout(
      () =>
        finish(
          new Error(
            "Legacy offline data purge timed out because another tab may still be open.",
          ),
        ),
      4_000,
    );
    const request = indexedDB.deleteDatabase("fieldproof-offline");
    request.onsuccess = () => finish();
    request.onerror = () =>
      finish(
        request.error ?? new Error("Legacy offline data purge failed."),
      );
    request.onblocked = () =>
      undefined;
  });
}

function isLoopback(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}
