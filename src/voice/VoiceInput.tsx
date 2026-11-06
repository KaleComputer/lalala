import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { type CSSProperties, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { prepareImageForAttachment } from "~/lib/imageCompression";
import { randomUUID } from "~/lib/utils";

/** A file T3 already holds as a pending upload; the send claims it for the voice thread. */
export type VoiceFileRef = {
  readonly type: "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
};

/** Sends one file to T3 (its attachment upload), reporting progress; abort drops it. */
export type VoiceFileUpload = (
  file: File,
  onProgress: (fraction: number) => void,
) => { readonly done: Promise<VoiceFileRef>; readonly abort: () => void };

type Picked =
  | { readonly id: string; readonly kind: "image"; readonly file: File; readonly url: string }
  | {
      readonly id: string;
      readonly kind: "file";
      readonly name: string;
      readonly progress: number;
      readonly ref: VoiceFileRef | null;
      readonly failed: boolean;
    };

/** Typed text, pictures and uploaded files for the voice thread; resolves true once the thread has them. */
export type VoiceInputSubmit = (
  text: string,
  images: ReadonlyArray<File>,
  files: ReadonlyArray<VoiceFileRef>,
) => Promise<boolean>;

const isImage = (file: File) => file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name);
const MAX_FILE_MB = PROVIDER_SEND_TURN_MAX_FILE_BYTES / 1024 / 1024;

/**
 * Text, links, pictures and files for the voice thread (the user, 3 Nov, design C; 6 Nov: one slim tab showing
 * only a keyboard, the field's own paperclip attaches). Files upload to T3 at once and sit over
 * the field as tiles. The tab's beam projects the field (the user, 4 Nov, design 9); Esc, the tab again, or a
 * send plays it back.
 */
export function VoiceInput(props: {
  readonly tabHost: HTMLElement;
  readonly panelHost: HTMLElement;
  /** The bar: files dropped anywhere on it land here, and the phone keyboard lifts it. */
  readonly bar: HTMLElement;
  /** A call is on; out of a call the tab is an empty, inert slot and an open field closes. */
  readonly live: boolean;
  readonly onSubmit: VoiceInputSubmit;
  /** T3's attachment upload; none, pictures only. */
  readonly upload?: VoiceFileUpload | undefined;
}) {
  // "closing" plays the hologram back (field, then beam) before the field unmounts.
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const open = phase === "open";
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<ReadonlyArray<Picked>>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Every tile's object URL and running upload, freed when its tile goes or the bar does.
  const [urls] = useState(() => new Set<string>());
  const [uploads] = useState(() => new Map<string, () => void>());
  const free = (item: Picked) => {
    if (item.kind === "image") {
      URL.revokeObjectURL(item.url);
      urls.delete(item.url);
    } else {
      uploads.get(item.id)?.();
      uploads.delete(item.id);
    }
  };
  const update = (id: string, change: (item: Picked & { kind: "file" }) => Picked) =>
    setPicked((current) =>
      current.map((item) => (item.id === id && item.kind === "file" ? change(item) : item)),
    );

  const startUpload = (upload: VoiceFileUpload, file: File): Picked => {
    const id = randomUUID();
    let step = -1;
    const handle = upload(file, (fraction) => {
      // Whole 5% steps, so a big file re-renders the bar twenty times, not per chunk.
      const next = Math.floor(fraction * 20);
      if (next === step) return;
      step = next;
      update(id, (item) => ({ ...item, progress: next / 20 }));
    });
    uploads.set(id, handle.abort);
    handle.done.then(
      (ref) => {
        uploads.delete(id);
        update(id, (item) => ({ ...item, ref, progress: 1 }));
      },
      () => {
        if (!uploads.delete(id)) return;
        setProblem("Upload failed");
        update(id, (item) => ({ ...item, failed: true }));
      },
    );
    return { id, kind: "file", name: file.name || "file", progress: 0, ref: null, failed: false };
  };

  const add = async (files: ReadonlyArray<File>) => {
    if (files.length === 0 || !props.live) return;
    setPhase("open");
    setProblem(null);
    const next: Picked[] = [];
    for (const file of files) {
      if (!isImage(file)) {
        if (!props.upload) setProblem("Pictures only here");
        else if (file.size === 0) setProblem("Empty file");
        else if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
          setProblem(`File too large (${MAX_FILE_MB} MB max)`);
        else next.push(startUpload(props.upload, file));
        continue;
      }
      const result = await prepareImageForAttachment(
        file,
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      ).catch(() => ({ ok: false, reason: "unreadable" }) as const);
      if (!result.ok) {
        setProblem(result.reason === "unreadable" ? "Not a readable image" : "Image too large");
        continue;
      }
      const url = URL.createObjectURL(result.file);
      urls.add(url);
      next.push({ id: randomUUID(), kind: "image", file: result.file, url });
    }
    setPicked((current) => [...current, ...next]);
    fieldRef.current?.focus();
  };
  const addDropped = useEffectEvent((files: ReadonlyArray<File>) => void add(files));

  const remove = (id: string) => {
    const gone = picked.find((item) => item.id === id);
    if (gone) free(gone);
    setPicked((current) => current.filter((item) => item.id !== id));
  };

  const close = () => {
    setProblem(null);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setPhase((current) => (current === "closed" || still ? "closed" : "closing"));
  };
  const closeByKey = useEffectEvent(() => close());

  // The call ending closes an open field (played back) before the tabs empty.
  const [wasLive, setWasLive] = useState(props.live);
  if (wasLive !== props.live) {
    setWasLive(props.live);
    if (!props.live && phase === "open") close();
  }

  const files = picked.filter((item) => item.kind === "file");
  const uploading = files.filter((item) => item.ref === null && !item.failed);
  const failed = files.some((item) => item.failed);
  const ready =
    !busy && uploading.length === 0 && !failed && (text.trim() !== "" || picked.length > 0);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    const ok = await props.onSubmit(
      text.trim(),
      picked.flatMap((item) => (item.kind === "image" ? [item.file] : [])),
      files.flatMap((item) => (item.ref === null ? [] : [item.ref])),
    );
    setBusy(false);
    if (!ok) {
      setProblem("Not sent");
      return;
    }
    for (const item of picked) if (item.kind === "image") free(item);
    setPicked([]);
    setText("");
    close();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- frees the tiles' object URLs and stops their uploads when the bar goes away
  useEffect(
    () => () => {
      for (const url of urls) URL.revokeObjectURL(url);
      for (const abort of uploads.values()) abort();
      uploads.clear();
    },
    [urls, uploads],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- files dropped on the bar (Presence's DOM, outside React) open the field with them
  useEffect(() => {
    const bar = props.bar;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      addDropped([...(event.dataTransfer?.files ?? [])]);
    };
    bar.addEventListener("dragover", onOver);
    bar.addEventListener("drop", onDrop);
    return () => {
      bar.removeEventListener("dragover", onOver);
      bar.removeEventListener("drop", onDrop);
    };
  }, [props.bar]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- while open: Esc closes from anywhere, and the phone keyboard (visual viewport) lifts the bar over itself
  useEffect(() => {
    if (!open) return;
    // The field's text is under 16px, which makes iOS zoom in on focus; capping the page's scale while
    // the field is open stops that (iOS still lets the user pinch-zoom).
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const viewportBefore = viewportMeta?.content ?? null;
    if (viewportMeta && !/maximum-scale/.test(viewportMeta.content))
      viewportMeta.content = `${viewportMeta.content}, maximum-scale=1`;
    fieldRef.current?.focus();
    const bar = props.bar;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeByKey();
    };
    const viewport = window.visualViewport;
    const lift = () => {
      if (!viewport) return;
      const keyboard = Math.round(window.innerHeight - viewport.height - viewport.offsetTop);
      if (keyboard > 40) bar.style.setProperty("--kb", `${keyboard}px`);
      else bar.style.removeProperty("--kb");
    };
    document.addEventListener("keydown", onKey);
    viewport?.addEventListener("resize", lift);
    viewport?.addEventListener("scroll", lift);
    lift();
    return () => {
      document.removeEventListener("keydown", onKey);
      viewport?.removeEventListener("resize", lift);
      viewport?.removeEventListener("scroll", lift);
      bar.style.removeProperty("--kb");
      if (viewportMeta && viewportBefore !== null) viewportMeta.content = viewportBefore;
    };
  }, [open, props.bar]);

  const grow = (field: HTMLTextAreaElement) => {
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  };

  const uploadProgress =
    uploading.length === 0
      ? null
      : uploading.reduce((sum, item) => sum + item.progress, 0) / uploading.length;

  const tabs = (
    <>
      <button
        type="button"
        data-lalala-input-tab=""
        data-open={open ? "" : undefined}
        data-state={phase}
        data-failed={failed ? "" : undefined}
        style={
          uploadProgress === null
            ? undefined
            : ({ "--lalala-upload": uploadProgress } as CSSProperties)
        }
        aria-expanded={open}
        aria-hidden={!props.live}
        tabIndex={props.live ? undefined : -1}
        aria-label={
          uploadProgress !== null
            ? `Uploading, ${Math.round(uploadProgress * 100)}%`
            : failed
              ? "An upload failed"
              : open
                ? "Close input"
                : "Type or attach for the voice thread"
        }
        onClick={() => (open ? close() : setPhase("open"))}
      >
        <i aria-hidden="true" />
        <b
          data-lalala-beam=""
          aria-hidden="true"
          onAnimationEnd={(event) => {
            if (event.animationName === "lalala-beam-down")
              setPhase((current) => (current === "closing" ? "closed" : current));
          }}
        />
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="2.5" y="5.5" width="19" height="13" rx="1.5" />
          <path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M6.5 12.5h.01M17 12.5h.01M10 12.5h4M8 15.5h8" />
        </svg>
        {uploadProgress !== null ? <s data-lalala-upload-bar="" aria-hidden="true" /> : null}
      </button>
      {/* Outside the field, so it stays mounted while the field plays back. */}
      <input
        ref={fileRef}
        type="file"
        accept={props.upload ? undefined : "image/*"}
        multiple
        hidden
        onChange={(event) => {
          void add([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
    </>
  );

  const panel =
    phase === "closed" ? null : (
      <div data-lalala-input-panel="" data-state={phase}>
        {picked.length > 0 ? (
          <ul data-lalala-input-tiles="">
            {picked.map((item) => (
              <li
                key={item.id}
                data-file={item.kind === "file" ? "" : undefined}
                data-failed={item.kind === "file" && item.failed ? "" : undefined}
                style={
                  item.kind === "file" && item.ref === null && !item.failed
                    ? ({ "--lalala-upload": item.progress } as CSSProperties)
                    : undefined
                }
              >
                {item.kind === "image" ? (
                  <img src={item.url} alt="" />
                ) : (
                  <span>
                    <span>{item.name}</span>
                    <span>
                      {item.failed
                        ? "failed"
                        : item.ref === null
                          ? `${Math.round(item.progress * 100)}%`
                          : "ready"}
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  aria-label={item.kind === "image" ? "Remove image" : `Remove ${item.name}`}
                  onClick={() => remove(item.id)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {problem !== null ? <p data-lalala-input-problem="">{problem}</p> : null}
        <div data-lalala-input-field="">
          <div>
            <textarea
              ref={fieldRef}
              rows={1}
              value={text}
              placeholder={
                files.length > 0 ? "a short note (optional)" : "text, link, image or file"
              }
              aria-label="Message for the voice thread"
              enterKeyHint="send"
              onChange={(event) => {
                setText(event.target.value);
                grow(event.target);
              }}
              onPaste={(event) => {
                const pasted = [...event.clipboardData.files];
                if (pasted.length === 0) return;
                event.preventDefault();
                void add(pasted);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <button
              type="button"
              data-lalala-input-cell=""
              aria-label={props.upload ? "Attach files" : "Attach images"}
              onClick={() => fileRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" />
              </svg>
            </button>
            <button
              type="button"
              data-lalala-input-cell=""
              data-send=""
              aria-label={uploading.length > 0 ? "Uploading…" : "Send to the voice thread"}
              disabled={!ready}
              onClick={() => void submit()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    );

  return (
    <>
      {createPortal(tabs, props.tabHost)}
      {panel !== null ? createPortal(panel, props.panelHost) : null}
    </>
  );
}
