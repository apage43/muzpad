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
const skipped = new Set(["assets", "out", "node_modules", "target", "dist"]);

export async function readFolder(root: DirectoryHandle) {
  const files: Record<string, string> = {};
  let bytes = 0;
  async function visit(dir: DirectoryHandle, prefix = "") {
    for await (const entry of dir.values()) {
      if (entry.name.startsWith(".") || skipped.has(entry.name)) continue;
      const path = prefix + entry.name;
      if (entry.kind === "directory") await visit(entry, `${path}/`);
      else if (supportedFile(path)) {
        const file = await entry.getFile();
        bytes += file.size;
        if (bytes > 4_000_000 || Object.keys(files).length >= 500)
          throw new Error(
            "Open a project with at most 500 source files and 4 MB of text.",
          );
        files[path] = await file.text();
      }
    }
  }
  await visit(root);
  return files;
}

export class MountedFolder {
  baseline: Record<string, string>;
  constructor(
    public root: DirectoryHandle,
    files: Record<string, string>,
  ) {
    this.baseline = { ...files };
  }
  changes(files: Record<string, string>) {
    return Object.entries(files).filter(
      ([path, text]) => this.baseline[path] !== text,
    );
  }
  async handle(path: string, create: boolean) {
    const parts = path.split("/");
    if (parts.some((p) => !p || p === "." || p === ".." || p.includes("\\")))
      throw new Error("Choose a project-relative filename.");
    let dir = this.root;
    for (const part of parts.slice(0, -1))
      dir = await dir.getDirectoryHandle(part, { create });
    return dir.getFileHandle(parts.at(-1)!, { create });
  }
  async save(files: Record<string, string>) {
    const permission = { mode: "readwrite" } as const;
    if (
      (await this.root.queryPermission(permission)) !== "granted" &&
      (await this.root.requestPermission(permission)) !== "granted"
    )
      throw new Error(
        "Folder write access was not granted. Your edits are still in this browser; you can download the project as a ZIP.",
      );
    const changes = this.changes(files);
    // Check every changed file before writing any, including newly created paths.
    for (const [path] of changes) {
      let disk: string | undefined;
      try {
        disk = await (await (await this.handle(path, false)).getFile()).text();
      } catch (e) {
        if ((e as Error).name !== "NotFoundError") throw e;
      }
      if (disk !== this.baseline[path])
        throw new Error(
          `${path} changed outside muzpad. Download your edits, then reopen the folder to load the disk version. No files were written.`,
        );
    }
    for (const [path, text] of changes) {
      const writer = await (await this.handle(path, true)).createWritable();
      try {
        await writer.write(text);
        await writer.close();
      } catch (e) {
        await writer.abort().catch(() => {});
        throw e;
      }
      this.baseline[path] = text;
    }
    return changes.length;
  }
}
