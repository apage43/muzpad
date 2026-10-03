import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../src/host/web-preferences.ts", import.meta.url), "utf8");
const preferencesSource = stripTypeScriptTypes(await readFile(new URL("../src/preferences.ts",import.meta.url),"utf8"));
const preferencesURL = "data:text/javascript;base64," + Buffer.from(preferencesSource).toString("base64");
const {PreferencesController} = await import(preferencesURL);
const outputText = stripTypeScriptTypes(source).replace('from "../preferences"',`from ${JSON.stringify(preferencesURL)}`);
const { WebPreferencesStore } = await import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));
function storage(initial) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test("legacy settings migrate only after successful versioned write", async () => {
  const disk = storage({ "muzpad-theme": "light", "muzpad-inspector": "closed" });
  const failures = [];
  const store = new WebPreferencesStore((failure) => failures.push(failure), disk);
  const value = await store.load();
  assert.equal(value.version, 1);
  assert.equal(value.theme, "light");
  assert.equal(value.layout.inspector, false);
  assert.equal(disk.getItem("muzpad-theme"), null);
  assert.equal(disk.getItem("muzpad-inspector"), null);
  assert.equal(JSON.parse(disk.getItem("muzpad-preferences-v1")).theme, "light");
  assert.equal(failures.length, 0);
});

test("valid versioned record wins over legacy preferences", async () => {
  const current = { version: 1, theme: "soft-dark", layout: { sourceFraction: 0.4 } };
  const disk = storage({ "muzpad-preferences-v1": JSON.stringify(current), "muzpad-theme": "light" });
  const store = new WebPreferencesStore(() => {}, disk);
  assert.deepEqual(await store.load(), current);
});

test("denied writes preserve legacy keys and session settings with actionable failure", async () => {
  const disk = storage({ "muzpad-theme": "dark", "muzpad-inspector": "open" });
  disk.setItem = () => { throw new Error("quota denied"); };
  const failures = [];
  const store = new WebPreferencesStore((failure) => failures.push(failure), disk);
  const value = await store.load();
  assert.equal(value.theme, "dark");
  assert.equal(disk.getItem("muzpad-theme"), "dark");
  assert.match(failures[0].message, /session.*browser storage/);
  disk.getItem = () => { throw new Error("denied read"); };
  await assert.rejects(store.save({ ...value, theme: "soft-light" }), { code: "permission_denied" });
  assert.equal((await store.load()).theme, "soft-light");
});

test("a denied storage getter keeps each save rejected while retaining session settings", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true, get() { throw new Error("storage getter denied"); },
  });
  try {
    const failures = [];
    const store = new WebPreferencesStore((failure) => failures.push(failure));
    let temporary = true;
    for (const theme of ["dark", "soft-light"]) {
      const value = { version: 1, theme, layout: { explorer: true, source: true,
        visualization: true, inspector: true, sourceFraction: 0.5 } };
      await assert.rejects(store.save(value).then(() => { temporary = false; }), { code: "permission_denied" });
      assert.equal(temporary, true, "a failed persistence attempt must not clear the UI warning");
      assert.deepEqual(await store.load(), value);
    }
    assert.equal(failures.length, 3, "constructor failure and both save attempts are reported");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("empty browser origin uses shared source-primary progressive defaults without synthesizing a saved choice",async()=>{
  const disk=storage({}),store=new WebPreferencesStore(()=>{},disk);
  assert.equal(await store.load(),null);
  const controller=await PreferencesController.load(store);
  assert.equal(controller.value.layout.source,true);
  assert.equal(controller.value.layout.visualization,true);
  assert.ok(controller.value.layout.sourceFraction>0.5,"source owns the majority of the primary split");
  assert.equal(controller.value.layout.inspector,false,"optional inspector starts progressively disclosed");
  assert.equal(disk.getItem("muzpad-preferences-v1"),null,"absence must not become a synthetic historical layout");
});

test("legacy theme alone does not invent an inspector-open choice; explicit legacy inspector choices survive migration",async()=>{
  const themeOnly=await PreferencesController.load(new WebPreferencesStore(()=>{},storage({"muzpad-theme":"dark"})));
  assert.equal(themeOnly.value.theme,"dark");assert.equal(themeOnly.value.layout.inspector,false);
  assert.ok(themeOnly.value.layout.sourceFraction>0.5);
  for(const [choice,expected] of [["open",true],["closed",false]]){
    const disk=storage({"muzpad-inspector":choice});
    const controller=await PreferencesController.load(new WebPreferencesStore(()=>{},disk));
    assert.equal(controller.value.layout.inspector,expected);
    assert.ok(controller.value.layout.sourceFraction>0.5,"legacy has no saved split fraction to override the shared default");
    assert.equal(disk.getItem("muzpad-inspector"),null);
  }
});

test("genuine saved v1 layout remains exact while reset alone restores shared progressive source-primary behavior",async()=>{
  const saved={version:1,theme:"soft-dark",layout:{explorer:false,source:true,visualization:false,inspector:true,sourceFraction:0.43}};
  const disk=storage({"muzpad-preferences-v1":JSON.stringify(saved),"muzpad-inspector":"closed"});
  const controller=await PreferencesController.load(new WebPreferencesStore(()=>{},disk));
  assert.deepEqual(controller.value,saved);
  controller.resetLayout();
  assert.equal(controller.value.theme,saved.theme);
  assert.equal(controller.value.layout.inspector,false);
  assert.equal(controller.value.layout.source,true);
  assert.equal(controller.value.layout.visualization,true);
  assert.ok(controller.value.layout.sourceFraction>0.5);
});
