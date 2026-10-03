import {
  ASSET_LIMITS,
  createAsset,
  isAssetPath,
  normalizeProjectPath,
  assetTransfers,
} from "./assets.js";

type FileHandle = {
  kind: "file";
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(text: string): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }>;
};
export type DirectoryHandle = {
  kind: "directory";
  name: string;
  values(): AsyncIterable<(FileHandle & { name: string }) | DirectoryHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  isSameEntry?(other: DirectoryHandle): Promise<boolean>;
  queryPermission(options: { mode: "readwrite" }): Promise<string>;
  requestPermission(options: { mode: "readwrite" }): Promise<string>;
};
type PickerWindow = Window & {
  showDirectoryPicker?: (options: {
    mode: "readwrite";
    id: string;
  }) => Promise<DirectoryHandle>;
};
export const canMountFolder = () =>
  !!(window as PickerWindow).showDirectoryPicker;
export const pickFolder = () =>
  (window as PickerWindow).showDirectoryPicker!({
    mode: "readwrite",
    id: "muzpad-project",
  });
export const supportedFile = (path: string) =>
  /\.(muz|md)$/i.test(path) || path === "muzpad.json";
const skipped = new Set(["out", "node_modules", "target", "dist"]);

export async function readProjectFolder(root: DirectoryHandle) {
  const files: Record<string, string> = {};
  const assets: Record<string, Awaited<ReturnType<typeof createAsset>>> = {};
  let textBytes = 0;
  let assetBytes = 0;
  let assetCount = 0;
  async function visit(dir: DirectoryHandle, prefix = "") {
    for await (const entry of dir.values()) {
      if (entry.name.startsWith(".") || skipped.has(entry.name)) continue;
      const path = normalizeProjectPath(prefix + entry.name);
      if (entry.kind === "directory") await visit(entry, `${path}/`);
      else if (supportedFile(path)) {
        const file = await entry.getFile();
        textBytes += file.size;
        if (textBytes > 4_000_000 || Object.keys(files).length >= 500)
          throw new Error(
            "Open a project with at most 500 source files and 4 MB of text.",
          );
        files[path] = await file.text();
      } else if (isAssetPath(path)) {
        const file = await entry.getFile();
        if (file.size > ASSET_LIMITS.maxFileBytes)
          throw new Error(`${path} exceeds the per-file asset limit.`);
        assetBytes += file.size;
        assetCount++;
        if (assetBytes > ASSET_LIMITS.maxTotalBytes)
          throw new Error(
            `Project assets exceed ${ASSET_LIMITS.maxTotalBytes} bytes.`,
          );
        if (assetCount > ASSET_LIMITS.maxFiles)
          throw new Error(
            `Project contains more than ${ASSET_LIMITS.maxFiles} assets.`,
          );
        assets[path] = await createAsset(path, await file.arrayBuffer());
      }
    }
  }
  await visit(root);
  assetTransfers(assets);
  return { files, assets };
}
