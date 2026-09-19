export const ASSET_LIMITS = Object.freeze({
  maxFiles: 256,
  maxFileBytes: 16_000_000,
  maxTotalBytes: 64_000_000,
});

const formats = Object.freeze({
  mid: "midi",
  midi: "midi",
  wav: "wav",
  flac: "flac",
});

/** Return a canonical, project-relative path or reject path escapes. */
export function normalizeProjectPath(input) {
  if (
    typeof input !== "string" ||
    !input ||
    input.startsWith("/") ||
    input.includes("\\") ||
    input.includes(":") ||
    input.includes("\0")
  )
    throw new Error("Asset paths must be project-relative.");
  const path = input;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error(`Asset path escapes the project: ${input}`);
  return parts.join("/");
}

export function assetFormat(path) {
  const extension = normalizeProjectPath(path).split(".").at(-1)?.toLowerCase();
  return formats[extension] ?? null;
}

export function isAssetPath(path) {
  try {
    return assetFormat(path) !== null;
  } catch {
    return false;
  }
}

function bytesToBase64(bytes) {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(result);
}

function base64ToBytes(value) {
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Asset bytes are not valid base64.");
  }
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  return result;
}

async function versionOf(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

/** Create the immutable, JSON-safe representation stored with a project. */
export async function createAsset(path, input) {
  path = normalizeProjectPath(path);
  const format = assetFormat(path);
  if (!format) throw new Error(`Unsupported binary asset: ${path}`);
  const bytes =
    input instanceof Uint8Array ? input.slice() : new Uint8Array(input);
  if (bytes.byteLength > ASSET_LIMITS.maxFileBytes)
    throw new Error(
      `${path} exceeds the ${ASSET_LIMITS.maxFileBytes} byte asset limit.`,
    );
  return Object.freeze({
    format,
    version: await versionOf(bytes),
    byteLength: bytes.byteLength,
    base64: bytesToBase64(bytes),
  });
}

/** Validate serialized records and return independently owned transfer bytes. */
export function assetTransfers(assets, limits = ASSET_LIMITS) {
  const entries = Object.entries(assets ?? {});
  if (entries.length > limits.maxFiles)
    throw new Error(`Project contains more than ${limits.maxFiles} assets.`);
  let total = 0;
  return entries.map(([originalPath, record]) => {
    const path = normalizeProjectPath(originalPath);
    const format = assetFormat(path);
    if (!format || record?.format !== format)
      throw new Error(`Asset format does not match its path: ${path}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(record.version))
      throw new Error(`Asset has an invalid version: ${path}`);
    if (
      typeof record.base64 !== "string" ||
      record.base64.length > Math.ceil(limits.maxFileBytes / 3) * 4
    )
      throw new Error(`${path} exceeds the per-file asset limit.`);
    const bytes = base64ToBytes(record.base64);
    if (bytes.byteLength !== record.byteLength)
      throw new Error(`Asset byte length does not match its record: ${path}`);
    if (bytes.byteLength > limits.maxFileBytes)
      throw new Error(`${path} exceeds the per-file asset limit.`);
    total += bytes.byteLength;
    if (total > limits.maxTotalBytes)
      throw new Error(`Project assets exceed ${limits.maxTotalBytes} bytes.`);
    return { path, format, version: record.version, bytes };
  });
}

/** Check that every content-addressed version still matches its stored bytes. */
export async function verifiedAssetTransfers(assets, limits = ASSET_LIMITS) {
  const transfers = assetTransfers(assets, limits);
  for (const transfer of transfers)
    if ((await versionOf(transfer.bytes)) !== transfer.version)
      throw new Error(
        `Asset version does not match its bytes: ${transfer.path}`,
      );
  return transfers;
}

/** Build ZIP input without combining text and binary storage in project state. */
export function projectArchiveEntries(files, assets) {
  const entries = {};
  const encoder = new TextEncoder();
  for (const [originalPath, text] of Object.entries(files)) {
    const path = normalizeProjectPath(originalPath);
    if (entries[path]) throw new Error(`Duplicate project path: ${path}`);
    entries[path] = encoder.encode(text);
  }
  for (const transfer of assetTransfers(assets)) {
    if (entries[transfer.path])
      throw new Error(`Duplicate project path: ${transfer.path}`);
    entries[transfer.path] = transfer.bytes;
  }
  return entries;
}

/** Split already-unzipped entries into text and immutable binary records. */
export async function importArchiveEntries(entries) {
  const files = {};
  const assets = {};
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let textBytes = 0;
  let binaryBytes = 0;
  let binaryFiles = 0;
  for (const [originalPath, value] of Object.entries(entries)) {
    if (originalPath.endsWith("/") && value.byteLength === 0) {
      normalizeProjectPath(originalPath.slice(0, -1));
      continue;
    }
    const path = normalizeProjectPath(originalPath);
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (isAssetPath(path)) {
      binaryBytes += bytes.length;
      binaryFiles++;
      if (
        binaryBytes > ASSET_LIMITS.maxTotalBytes ||
        binaryFiles > ASSET_LIMITS.maxFiles
      )
        throw new Error("Project exceeds asset limits.");
      assets[path] = await createAsset(path, bytes);
    } else if (/\.(muz|md)$/i.test(path) || path === "muzpad.json") {
      textBytes += bytes.byteLength;
      if (textBytes > 4_000_000)
        throw new Error("Project contains more than 4 MB of text.");
      files[path] = decoder.decode(bytes);
    }
  }
  assetTransfers(assets);
  return { files, assets };
}

export function assertSourceOnlyShareable(assets) {
  const paths = Object.keys(assets ?? {});
  if (paths.length)
    throw new Error(
      `Source-only sharing cannot include binary assets (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", …" : ""}). Export the project ZIP instead.`,
    );
}
