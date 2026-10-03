const DATABASE = "muzpad-projects-v1";
const VERSION = 2;
const PROJECTS = "projects";
const ASSETS = "assets";
const DIRECTORIES = "directories";
const saves = new Map();

function storageId(key) {
  return `project:${key}`;
}

function marker(id) {
  return JSON.stringify({ storage: "indexeddb", id });
}

function parseStored(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

async function database() {
  if (!globalThis.indexedDB) throw new Error("IndexedDB is unavailable.");
  const request = globalThis.indexedDB.open(DATABASE, VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(PROJECTS))
      db.createObjectStore(PROJECTS, { keyPath: "id" });
    if (!db.objectStoreNames.contains(ASSETS))
      db.createObjectStore(ASSETS, { keyPath: "id" });
    if (!db.objectStoreNames.contains(DIRECTORIES))
      db.createObjectStore(DIRECTORIES, { keyPath: "id" });
  };
  return requestResult(request);
}

async function removeIndexedProject(id) {
  if (!globalThis.indexedDB) return;
  const db = await database();
  try {
    const transaction = db.transaction([PROJECTS, ASSETS], "readwrite");
    transaction.objectStore(PROJECTS).delete(id);
    transaction.objectStore(ASSETS).delete(id);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

/** True when a legacy project or IndexedDB marker exists for this key. */
export function hasStoredProject(key) {
  return globalThis.localStorage?.getItem(key) != null;
}

/**
 * Load a project without migrating it. Existing full localStorage projects take
 * precedence; only the explicit small marker consults IndexedDB.
 */
export async function loadStoredProject(key) {
  await saves.get(key)?.catch(() => {});
  const stored = parseStored(globalThis.localStorage?.getItem(key));
  if (!stored) return null;
  if (stored.storage !== "indexeddb" || typeof stored.id !== "string")
    return stored;

  const db = await database();
  try {
    const transaction = db.transaction([PROJECTS, ASSETS], "readonly");
    const projectRequest = transaction.objectStore(PROJECTS).get(stored.id);
    const assetsRequest = transaction.objectStore(ASSETS).get(stored.id);
    const [projectRecord, assetRecord] = await Promise.all([
      requestResult(projectRequest),
      requestResult(assetsRequest),
      transactionDone(transaction),
    ]);
    if (!projectRecord?.project || !assetRecord?.assets) return null;
    return { ...projectRecord.project, assets: assetRecord.assets };
  } finally {
    db.close();
  }
}

/**
 * Store asset-bearing projects atomically in IndexedDB. Text-only projects keep
 * the historical localStorage representation used by existing drafts/tests.
 */
export function saveStoredProject(key, project) {
  // Capture the requested revision before waiting for IndexedDB; later editor
  // mutations must not alter a queued save. Serialize each slot's writes.
  const captured = structuredClone(project);
  const pending = (saves.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => storeProject(key, captured));
  saves.set(key, pending);
  const cleanup = () => {
    if (saves.get(key) === pending) saves.delete(key);
  };
  pending.then(cleanup, cleanup);
  return pending;
}

async function storeProject(key, project) {
  const previous = globalThis.localStorage.getItem(key);
  const assets = project?.assets;
  if (!assets || Object.keys(assets).length === 0) {
    // Mutate the marker only after serialization succeeds. If quota/security
    // rejects this write, the previous localStorage value and IndexedDB record remain.
    const serialized = JSON.stringify(project);
    globalThis.localStorage.setItem(key, serialized);
    await removeIndexedProject(storageId(key)).catch(() => {});
    return;
  }

  const id = storageId(key);
  const { assets: _assets, ...description } = project;
  const db = await database();
  try {
    const transaction = db.transaction([PROJECTS, ASSETS], "readwrite");
    transaction.objectStore(PROJECTS).put({ id, project: description });
    transaction.objectStore(ASSETS).put({ id, assets });
    await transactionDone(transaction);
  } finally {
    db.close();
  }
  // An IndexedDB failure above leaves the previous localStorage value untouched.
  const nextMarker = marker(id);
  if (previous !== nextMarker) {
    try {
      globalThis.localStorage.setItem(key, nextMarker);
    } catch (error) {
      // A legacy value still wins on load. Remove the unreferenced new record so
      // a marker failure cannot leak asset storage.
      await removeIndexedProject(id).catch(() => {});
      throw error;
    }
  }
}

/** Remove a recovery/recent slot after its queued writes have settled. */
export async function removeStoredProject(key) {
  await saves.get(key)?.catch(() => {});
  globalThis.localStorage.removeItem(key);
  await removeIndexedProject(storageId(key));
}

/** Directory handles are structured-cloneable, but never JSON-serializable. */
export async function saveProjectDirectory(id, handle) {
  const db = await database();
  try {
    const transaction = db.transaction(DIRECTORIES, "readwrite");
    transaction.objectStore(DIRECTORIES).put({ id, handle });
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function loadProjectDirectory(id) {
  const db = await database();
  try {
    const transaction = db.transaction(DIRECTORIES, "readonly");
    const [record] = await Promise.all([
      requestResult(transaction.objectStore(DIRECTORIES).get(id)),
      transactionDone(transaction),
    ]);
    return record?.handle ?? null;
  } finally {
    db.close();
  }
}

export async function removeProjectDirectory(id) {
  const db = await database();
  try {
    const transaction = db.transaction(DIRECTORIES, "readwrite");
    transaction.objectStore(DIRECTORIES).delete(id);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}
