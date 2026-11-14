// Standalone stand-in for the fork's src/state/voiceUpload.ts: the bytes go to the dev server's T3
// bridge, which gets T3's attachment upload URL and forwards them (the phone cannot reach T3 itself).
type FileRef = {
  readonly type: "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
};
export type VoiceUpload = { readonly done: Promise<FileRef>; readonly abort: () => void };

export function uploadVoiceFile(
  _environmentId: string,
  file: File,
  onProgress: (fraction: number) => void,
): VoiceUpload {
  const xhr = new XMLHttpRequest();
  const mimeType = file.type || "application/octet-stream";
  const name = file.name || "file";
  const done = new Promise<FileRef>(
    (resolve, reject) => {
      xhr.open("POST", "/__lalala/t3/upload", true);
      xhr.setRequestHeader("content-type", mimeType);
      xhr.setRequestHeader("x-lalala-name", encodeURIComponent(name));
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
      });
      xhr.addEventListener("load", () => {
        let body: { attachmentId?: string; error?: string } = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && typeof body.attachmentId === "string") {
          resolve({ type: "file", id: body.attachmentId, name, mimeType, sizeBytes: file.size });
        } else reject(new Error(body.error ?? `Upload rejected (${xhr.status})`));
      });
      xhr.addEventListener("error", () => reject(new Error("Upload failed")));
      xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
      xhr.send(file);
    },
  );
  return { done, abort: () => xhr.abort() };
}
