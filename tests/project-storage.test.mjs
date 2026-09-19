import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  hasStoredProject,
  loadStoredProject,
  saveStoredProject,
} from "../src/project-storage.js";

class MemoryStorage {
  values = new Map();
  failWrites = false;
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    if (this.failWrites) throw new Error("storage full");
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
}

function fakeIndexedDB() {
  const stores = new Map();
  let failWrites = false;
  const request = (run) => {
    const value = {};
    queueMicrotask(() => {
      try {
        value.result = run();
        value.onsuccess?.();
      } catch (error) {
        value.error = error;
        value.onerror?.();
      }
    });
    return value;
  };
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) {
      stores.set(name, new Map());
    },
    transaction(names, mode) {
      const changes = [];
      const transaction = {
        objectStore(name) {
          return {
            put(value) {
              changes.push(() =>
                stores.get(name).set(value.id, structuredClone(value)),
              );
            },
            delete(id) {
              changes.push(() => stores.get(name).delete(id));
            },
            get(id) {
              return request(() => structuredClone(stores.get(name).get(id)));
            },
          };
        },
      };
      queueMicrotask(() => {
        if (mode === "readwrite" && failWrites) {
          transaction.error = new Error("write failed");
          transaction.onabort?.();
        } else {
          for (const change of changes) change();
          transaction.oncomplete?.();
        }
      });
      return transaction;
    },
    close() {},
  };
  return {
    open() {
      const open = {};
      queueMicrotask(() => {
        open.result = db;
        if (!stores.size) open.onupgradeneeded?.();
        open.onsuccess?.();
      });
      return open;
    },
    failWrites(value) {
      failWrites = value;
    },
    stores,
  };
}

let previousLocalStorage;
let previousIndexedDB;
beforeEach(() => {
  previousLocalStorage = globalThis.localStorage;
  previousIndexedDB = globalThis.indexedDB;
  globalThis.localStorage = new MemoryStorage();
  globalThis.indexedDB = fakeIndexedDB();
});
afterEach(() => {
  globalThis.localStorage = previousLocalStorage;
  globalThis.indexedDB = previousIndexedDB;
});

const textProject = {
  id: "p",
  title: "Project",
  entry: "song.muz",
  files: { "song.muz": "song({tracks:[]})" },
};
const asset = {
  format: "midi",
  version: "sha256:test",
  byteLength: 3,
  base64: "AQID",
};

test("text projects retain the legacy localStorage shape", async () => {
  await saveStoredProject("muzpad-draft-v1", textProject);
  assert.deepEqual(
    JSON.parse(localStorage.getItem("muzpad-draft-v1")),
    textProject,
  );
  assert.deepEqual(await loadStoredProject("muzpad-draft-v1"), textProject);
  assert.equal(hasStoredProject("muzpad-draft-v1"), true);
});

test("asset projects round-trip through an IndexedDB marker", async () => {
  const project = { ...textProject, assets: { "part.mid": asset } };
  await saveStoredProject("muzpad-draft-v1", project);
  assert.deepEqual(JSON.parse(localStorage.getItem("muzpad-draft-v1")), {
    storage: "indexeddb",
    id: "project:muzpad-draft-v1",
  });
  assert.deepEqual(await loadStoredProject("muzpad-draft-v1"), project);
  assert.equal(indexedDB.stores.get("projects").size, 1);
  assert.equal(indexedDB.stores.get("assets").size, 1);
});

test("legacy localStorage wins over stale IndexedDB and failed writes preserve it", async () => {
  const withAssets = { ...textProject, assets: { "part.mid": asset } };
  await saveStoredProject("muzpad-draft-v1", withAssets);
  const legacy = { ...textProject, title: "Legacy edits" };
  localStorage.setItem("muzpad-draft-v1", JSON.stringify(legacy));
  assert.deepEqual(await loadStoredProject("muzpad-draft-v1"), legacy);

  indexedDB.failWrites(true);
  await assert.rejects(
    saveStoredProject("muzpad-draft-v1", withAssets),
    /write failed/,
  );
  assert.equal(localStorage.getItem("muzpad-draft-v1"), JSON.stringify(legacy));
});

test("a marker failure keeps the legacy project and cleans the unreferenced record", async () => {
  localStorage.setItem("muzpad-draft-v1", JSON.stringify(textProject));
  localStorage.failWrites = true;
  await assert.rejects(
    saveStoredProject("muzpad-draft-v1", {
      ...textProject,
      assets: { "part.mid": asset },
    }),
    /storage full/,
  );
  localStorage.failWrites = false;
  assert.deepEqual(await loadStoredProject("muzpad-draft-v1"), textProject);
  assert.equal(indexedDB.stores.get("projects").size, 0);
  assert.equal(indexedDB.stores.get("assets").size, 0);
});

test("draft and Previous overwrite stable records instead of leaking versions", async () => {
  for (const key of ["muzpad-draft-v1", "muzpad-previous-v1"]) {
    await saveStoredProject(key, {
      ...textProject,
      id: key,
      assets: { "part.mid": asset },
    });
    await saveStoredProject(key, {
      ...textProject,
      id: `${key}-new`,
      assets: { "part.mid": asset },
    });
  }
  assert.equal(indexedDB.stores.get("projects").size, 2);
  assert.equal(indexedDB.stores.get("assets").size, 2);
});

test("queued saves capture revisions and serialize asset/text transitions", async () => {
  const first = {
    ...textProject,
    title: "First",
    assets: { "part.mid": asset },
  };
  const a = saveStoredProject("draft", first);
  first.title = "Mutated after save";
  await a;
  assert.equal((await loadStoredProject("draft")).title, "First");
  const b = saveStoredProject("draft", { ...textProject, title: "Text" });
  const c = saveStoredProject("draft", { ...first, title: "Latest" });
  await Promise.all([b, c]);
  assert.equal((await loadStoredProject("draft")).title, "Latest");
  assert.equal(indexedDB.stores.get("assets").size, 1);
});
