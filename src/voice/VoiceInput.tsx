import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { prepareImageForAttachment } from "~/lib/imageCompression";
import { randomUUID } from "~/lib/utils";

type Picked = { readonly id: string; readonly file: File; readonly url: string };

/** Typed text and pictures for the voice thread; resolves true once the thread has them. */
export type VoiceInputSubmit = (text: string, images: ReadonlyArray<File>) => Promise<boolean>;

const imagesOf = (files: Iterable<File>) =>
  [...files].filter((file) => file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name));

/**
 * Hand the voice thread typed text, a link or pictures: "› INPUT" in the
 * tab row left of the time opens one field docked over the bar; pictures sit on top of it as
 * equal tiles. Its emitter projects a hologram beam up and the field materializes on it (the user, 4 Nov,
 * design 9); Esc, the tab again, or a send plays it back. A drop on the bar opens it with the files.
 */
export function VoiceInput(props: {
  readonly tabHost: HTMLElement;
  readonly panelHost: HTMLElement;
  /** The bar: files dropped anywhere on it land here, and the phone keyboard lifts it. */
  readonly bar: HTMLElement;
  /** A call is on; out of a call the tab is tucked away and an open field closes. */
  readonly live: boolean;
  readonly onSubmit: VoiceInputSubmit;
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
  // Every tile's object URL, freed when its tile goes or the bar does.
  const [urls] = useState(() => new Set<string>());
  const free = (url: string) => {
    URL.revokeObjectURL(url);
    urls.delete(url);
  };

  const add = async (files: ReadonlyArray<File>) => {
    if (files.length === 0 || !props.live) return;
    setPhase("open");
    setProblem(null);
    const next: Picked[] = [];
    for (const file of files) {
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
      next.push({ id: randomUUID(), file: result.file, url });
    }
    setPicked((current) => [...current, ...next]);
    fieldRef.current?.focus();
  };
  const addDropped = useEffectEvent((files: ReadonlyArray<File>) => void add(files));

  const remove = (id: string) => {
    const gone = picked.find((item) => item.id === id);
    if (gone) free(gone.url);
    setPicked((current) => current.filter((item) => item.id !== id));
  };

  const close = () => {
    setProblem(null);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setPhase((current) => (current === "closed" || still ? "closed" : "closing"));
  };
  const closeByKey = useEffectEvent(() => close());

  // The call ending closes an open field (played back) before the tab tucks away.
  const [wasLive, setWasLive] = useState(props.live);
  if (wasLive !== props.live) {
    setWasLive(props.live);
    if (!props.live && phase === "open") close();
  }

  const submit = async () => {
    const message = text.trim();
    if (busy || (message === "" && picked.length === 0)) return;
    setBusy(true);
    setProblem(null);
    const ok = await props.onSubmit(
      message,
      picked.map((item) => item.file),
    );
    setBusy(false);
    if (!ok) {
      setProblem("Not sent");
      return;
    }
    for (const item of picked) free(item.url);
    setPicked([]);
    setText("");
    close();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- frees the tiles' object URLs when the bar goes away
  useEffect(
    () => () => {
      for (const url of urls) URL.revokeObjectURL(url);
    },
    [urls],
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
      addDropped(imagesOf(event.dataTransfer?.files ?? []));
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

  const tab = (
    <button
      type="button"
      data-t3voice-input-tab=""
      data-open={open ? "" : undefined}
      data-state={phase}
      aria-expanded={open}
      aria-hidden={!props.live}
      tabIndex={props.live ? undefined : -1}
      aria-label={open ? "Close input" : "Type or attach for the voice thread"}
      onClick={() => (open ? close() : setPhase("open"))}
    >
      <i aria-hidden="true" />
      <b
        data-t3voice-beam=""
        aria-hidden="true"
        onAnimationEnd={(event) => {
          if (event.animationName === "t3voice-beam-down")
            setPhase((current) => (current === "closing" ? "closed" : current));
        }}
      />
      <svg data-t3voice-input-plus="" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M6 1.5v9M1.5 6h9" />
      </svg>
    </button>
  );

  const panel =
    phase === "closed" ? null : (
      <div data-t3voice-input-panel="" data-state={phase}>
        {picked.length > 0 ? (
          <ul data-t3voice-input-tiles="">
            {picked.map((item) => (
              <li key={item.id}>
                <img src={item.url} alt="" />
                <button type="button" aria-label="Remove image" onClick={() => remove(item.id)}>
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {problem !== null ? <p data-t3voice-input-problem="">{problem}</p> : null}
        <div data-t3voice-input-field="">
          <div>
            <textarea
              ref={fieldRef}
              rows={1}
              value={text}
              placeholder="text, link or image"
              aria-label="Message for the voice thread"
              enterKeyHint="send"
              onChange={(event) => {
                setText(event.target.value);
                grow(event.target);
              }}
              onPaste={(event) => {
                const images = imagesOf(event.clipboardData.files);
                if (images.length === 0) return;
                event.preventDefault();
                void add(images);
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
              data-t3voice-input-cell=""
              aria-label="Attach images"
              onClick={() => fileRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" />
              </svg>
            </button>
            <button
              type="button"
              data-t3voice-input-cell=""
              data-send=""
              aria-label="Send to the voice thread"
              disabled={busy || (text.trim() === "" && picked.length === 0)}
              onClick={() => void submit()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            void add(imagesOf(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </div>
    );

  return (
    <>
      {createPortal(tab, props.tabHost)}
      {panel !== null ? createPortal(panel, props.panelHost) : null}
    </>
  );
}
