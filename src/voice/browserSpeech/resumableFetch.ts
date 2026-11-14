// Model downloads that survive a reload or a crashed tab: each model file's bytes go to IndexedDB in
// pieces as they arrive, and the next fetch asks Hugging Face (HTTP Range) only for the rest. The
// library on top (parakeet.js, transformers.js) still sees one plain 200 response for the whole file
// and keeps its own cache of the finished file; `forgetDownloads` drops ours once it has.
const DB = "lalala-downloads";
const PIECE = 8 * 1024 * 1024;
const MODEL_FILE = /^https:\/\/huggingface\.co\/[^?#]+\/resolve\/[^?#]+\.onnx(?:\.data|_data)?$/;

type Meta = { readonly size: number; readonly etag: string };

let opened: Promise<IDBDatabase> | null = null;
const db = () =>
  (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("files");
      request.result.createObjectStore("pieces");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));

function done<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const pieces = (url: string) => IDBKeyRange.bound([url, 0], [url, Number.MAX_SAFE_INTEGER]);

function committed(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

async function stored(url: string) {
  const tx = (await db()).transaction(["files", "pieces"]);
  const meta = (await done(tx.objectStore("files").get(url))) as Meta | undefined;
  const keys = (await done(tx.objectStore("pieces").getAllKeys(pieces(url)))) as [string, number][];
  const all = (await done(tx.objectStore("pieces").getAll(pieces(url)))) as Blob[];
  // Keys sort by offset; only the run without a gap from byte 0 counts.
  const blobs: Blob[] = [];
  let have = 0;
  for (const [index, blob] of all.entries()) {
    if (keys[index]?.[1] !== have) break;
    blobs.push(blob);
    have += blob.size;
  }
  return meta === undefined ? null : { meta, blobs, have };
}

async function clear(url: string) {
  const tx = (await db()).transaction(["files", "pieces"], "readwrite");
  tx.objectStore("files").delete(url);
  tx.objectStore("pieces").delete(pieces(url));
  await committed(tx);
}

async function begin(url: string, meta: Meta) {
  await clear(url);
  const tx = (await db()).transaction("files", "readwrite");
  tx.objectStore("files").put(meta, url);
  await committed(tx);
}

async function save(url: string, offset: number, chunks: Uint8Array[]) {
  const tx = (await db()).transaction("pieces", "readwrite");
  tx.objectStore("pieces").put(new Blob(chunks as BlobPart[]), [url, offset]);
  await committed(tx);
}

const etagOf = (response: Response) => response.headers.get("etag") ?? "";

/** The whole file as one 200: the bytes already saved, then the network's, saved as they pass. */
function whole(url: string, meta: Meta, saved: Blob[], have: number, network: Response | null) {
  const reader = network?.body?.getReader() ?? null;
  let next = 0;
  let offset = have;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let saving = true;
  const flush = async () => {
    if (!saving || pendingBytes === 0) return;
    const chunks = pending;
    const at = offset;
    offset += pendingBytes;
    pending = [];
    pendingBytes = 0;
    // A full disk only costs resuming; the download itself goes on, unsaved from here.
    await save(url, at, chunks).catch(() => (saving = false));
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next < saved.length) {
        controller.enqueue(new Uint8Array(await saved[next++]!.arrayBuffer()));
        return;
      }
      if (reader === null) return controller.close();
      const { done: finished, value } = await reader.read();
      if (finished) {
        await flush();
        return controller.close();
      }
      pending.push(value);
      pendingBytes += value.byteLength;
      if (pendingBytes >= PIECE) await flush();
      controller.enqueue(value);
    },
    cancel: (reason) => reader?.cancel(reason),
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-length": String(meta.size),
      "content-type": network?.headers.get("content-type") ?? "application/octet-stream",
      etag: meta.etag,
    },
  });
}

async function resume(next: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  const saved = await stored(url).catch(() => null);
  if (saved !== null && saved.have > 0) {
    const { meta, blobs, have } = saved;
    if (have >= meta.size) return whole(url, meta, blobs, have, null);
    const headers = new Headers(init?.headers);
    headers.set("range", `bytes=${have}-`);
    const response = await next(url, { ...init, headers });
    const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    if (
      response.status === 206 &&
      Number(range?.[1]) === have &&
      Number(range?.[2]) === meta.size &&
      etagOf(response) === meta.etag
    ) {
      return whole(url, meta, blobs, have, response);
    }
    void response.body?.cancel();
  }
  const response = await next(url, init);
  const size = Number(response.headers.get("content-length"));
  if (response.status !== 200 || !(size > 0) || response.body === null) return response;
  const meta = { size, etag: etagOf(response) };
  const ready = await begin(url, meta).then(
    () => true,
    () => false,
  );
  return ready ? whole(url, meta, [], 0, response) : response;
}

/** Wraps a worker's fetch so Hugging Face model files download resumably. */
export function resumableFetch(next: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if ((init?.method ?? "GET") !== "GET" || !MODEL_FILE.test(url)) return next(input, init);
    return resume(next, url, init);
  };
}

/** Drops saved pieces under `prefix` once the library's own cache holds those files. */
export async function forgetDownloads(prefix: string): Promise<void> {
  const tx = (await db()).transaction(["files", "pieces"], "readwrite");
  tx.objectStore("files").delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
  tx.objectStore("pieces").delete(IDBKeyRange.bound([prefix], [`${prefix}\uffff`]));
  await committed(tx);
}

/**
 * Downloads a model file straight into IndexedDB pieces and returns it as one disk-backed Blob, so
 * no more than a piece sits in memory and a crash resumes (Range) instead of replaying the file.
 */
export async function downloadFile(
  url: string,
  onBytes: (loaded: number, total: number) => void,
): Promise<Blob> {
  let saved = await stored(url).catch(() => null);
  let have = saved?.have ?? 0;
  let response: Response | null = null;
  if (saved !== null && have > 0 && have < saved.meta.size) {
    const ranged = await fetch(url, { headers: { range: `bytes=${have}-` } });
    const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(ranged.headers.get("content-range") ?? "");
    if (
      ranged.status === 206 &&
      Number(range?.[1]) === have &&
      Number(range?.[2]) === saved.meta.size &&
      etagOf(ranged) === saved.meta.etag
    ) {
      response = ranged;
    } else {
      void ranged.body?.cancel();
      saved = null;
    }
  }
  if (saved === null || have === 0) {
    response = await fetch(url);
    const size = Number(response.headers.get("content-length"));
    if (!response.ok || !(size > 0) || response.body === null) {
      void response.body?.cancel();
      throw new Error(`download ${response.status}`);
    }
    saved = { meta: { size, etag: etagOf(response) }, blobs: [], have: 0 };
    have = 0;
    await begin(url, saved.meta);
  }
  const { size } = saved.meta;
  onBytes(have, size);
  if (response !== null) {
    const reader = response.body!.getReader();
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (!finished) {
        pending.push(value);
        pendingBytes += value.byteLength;
      }
      if (pendingBytes > 0 && (finished || pendingBytes >= PIECE)) {
        await save(url, have, pending);
        have += pendingBytes;
        pending = [];
        pendingBytes = 0;
        onBytes(have, size);
      }
      if (finished) break;
    }
  }
  const full = await stored(url);
  if (full === null || full.have !== size) throw new Error("download incomplete");
  return new Blob(full.blobs);
}

/** The whole file is in IndexedDB. */
export async function isDownloaded(url: string): Promise<boolean> {
  const saved = await stored(url).catch(() => null);
  return saved !== null && saved.have === saved.meta.size;
}

/** Drops saved files under `prefix` other than `keep`. */
export async function keepDownloads(prefix: string, keep: readonly string[]): Promise<void> {
  const tx = (await db()).transaction(["files", "pieces"], "readwrite");
  const files = tx.objectStore("files");
  const urls = (await done(files.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)))) as string[];
  for (const url of urls.filter((url) => !keep.includes(url))) {
    files.delete(url);
    tx.objectStore("pieces").delete(pieces(url));
  }
  await committed(tx);
}
