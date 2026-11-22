import { Button } from "@ui-sdk/react/button";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Input } from "@ui-sdk/react/input";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Textarea } from "@ui-sdk/react/textarea";
import { useState, useSyncExternalStore } from "react";

import { CanvasCard } from "../extras/CanvasCard";
import {
  getActiveTemplates,
  removeTemplate,
  subscribeTemplates,
} from "../extras/canvasStore";
import { useCardState } from "../extras/cardState";
import {
  IMAGE_ASPECTS,
  IMAGE_STYLES,
  VIDEO_ASPECTS,
  VIDEO_DURATIONS,
  VIDEO_MOTIONS,
  buildChatPrompt,
  buildImageGenPrompt,
  buildTodoSyncPrompt,
  buildVideoGenPrompt,
  dispatchTemplatePrompt,
  logTemplateEvent,
  readTemplateCardData,
  type ImageAspect,
  type ImageStyle,
  type TemplateInstance,
  type VideoAspect,
  type VideoDuration,
  type VideoMotion,
} from "./registry";
import "./templateCards.css";

const formatClock = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

type TodoItem = {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly createdAt: number;
};
type TodoFilter = "all" | "open" | "done";

const DEFAULT_TODOS: readonly TodoItem[] = [];

function TodoTemplateCard(props: { readonly instance: TemplateInstance }) {
  const { id: cardId, title } = props.instance;
  const [items, setItems] = useCardState<readonly TodoItem[]>(cardId, "items", DEFAULT_TODOS, Array.isArray);
  const [filter, setFilter] = useCardState<TodoFilter>(
    cardId,
    "filter",
    "all",
    (v) => v === "all" || v === "open" || v === "done",
  );
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openCount = items.filter((item) => !item.done).length;
  const doneCount = items.length - openCount;
  const visible = items.filter((item) =>
    filter === "open" ? !item.done : filter === "done" ? item.done : true,
  );

  const addItem = () => {
    const text = draft.trim();
    if (text === "") return;
    const next: TodoItem = {
      id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      done: false,
      createdAt: Date.now(),
    };
    setItems((prev) => [next, ...prev]);
    setDraft("");
    setStatus(null);
    logTemplateEvent(cardId, "todo.add", { text });
  };

  const toggleItem = (itemId: string, done: boolean) => {
    setItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, done } : item)));
    logTemplateEvent(cardId, "todo.toggle", { itemId, done });
  };

  const removeItem = (itemId: string) => {
    setItems((prev) => prev.filter((item) => item.id !== itemId));
    logTemplateEvent(cardId, "todo.remove", { itemId });
  };

  const syncWithBrain = async () => {
    setBusy(true);
    try {
      const prompt = buildTodoSyncPrompt({
        cardId,
        title,
        openItems: items.filter((item) => !item.done).map((item) => item.text),
      });
      const result = await dispatchTemplatePrompt(prompt, {
        cardId,
        template: "todo",
        action: "sync",
      });
      setStatus(result.message);
    } finally {
      setBusy(false);
    }
  };

  const refreshFromData = async () => {
    setBusy(true);
    try {
      const data = await readTemplateCardData<{
        readonly items?: readonly { readonly id?: unknown; readonly text?: unknown; readonly done?: unknown }[];
      }>(cardId);
      if (!data || !Array.isArray(data.items)) {
        setStatus("No brain data file found yet.");
        return;
      }
      const parsed: TodoItem[] = data.items.flatMap((entry, index) => {
        if (typeof entry?.text !== "string" || entry.text.trim() === "") return [];
        return [
          {
            id: typeof entry.id === "string" && entry.id !== "" ? entry.id : `data-${index}`,
            text: entry.text.trim(),
            done: entry.done === true,
            createdAt: Date.now(),
          },
        ];
      });
      setItems(parsed);
      setStatus(`Loaded ${parsed.length} item${parsed.length === 1 ? "" : "s"}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-lalala-tpl="todo">
      <div data-lalala-tpl-row="">
        <Input
          data-lalala-tpl-input=""
          aria-label={`${title}: new task`}
          placeholder="Add a task…"
          value={draft}
          onValueChange={setDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addItem();
            }
          }}
        />
        <Button
          data-lalala-tpl-btn="primary"
          aria-label={`${title}: add task`}
          disabled={draft.trim() === ""}
          onClick={addItem}
        >
          Add
        </Button>
      </div>

      <div data-lalala-tpl-row="between">
        <SegmentedControl
          data-lalala-tpl-seg=""
          aria-label={`${title}: filter tasks`}
          value={filter}
          onValueChange={(next) => setFilter(next as TodoFilter)}
        >
          <SegmentedControlItem value="all" aria-label={`${title}: show all`}>
            All {items.length}
          </SegmentedControlItem>
          <SegmentedControlItem value="open" aria-label={`${title}: show open`}>
            Open {openCount}
          </SegmentedControlItem>
          <SegmentedControlItem value="done" aria-label={`${title}: show done`}>
            Done {doneCount}
          </SegmentedControlItem>
        </SegmentedControl>
        {doneCount > 0 ? (
          <Button
            data-lalala-tpl-btn="ghost"
            aria-label={`${title}: clear completed tasks`}
            onClick={() => setItems((prev) => prev.filter((item) => !item.done))}
          >
            Clear done
          </Button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p data-lalala-tpl-empty="">
          {items.length === 0
            ? "Add tasks above, or ask the brain to sync today's list."
            : "Nothing in this filter."}
        </p>
      ) : (
        <ul data-lalala-tpl-list="">
          {visible.map((item) => (
            <li
              key={item.id}
              data-lalala-tpl-todo-item=""
              data-done={item.done ? "" : undefined}
            >
              <Checkbox
                data-lalala-tpl-check=""
                aria-label={`${title}: mark "${item.text}" ${item.done ? "open" : "done"}`}
                checked={item.done}
                onCheckedChange={(checked) => toggleItem(item.id, checked === true)}
              >
                <CheckboxIndicator>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
                  </svg>
                </CheckboxIndicator>
              </Checkbox>
              <span>{item.text}</span>
              <Button
                data-lalala-tpl-btn="ghost"
                aria-label={`${title}: delete "${item.text}"`}
                onClick={() => removeItem(item.id)}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div data-lalala-tpl-row="wrap">
        <Button
          data-lalala-tpl-btn=""
          aria-label={`${title}: sync with brain`}
          disabled={busy}
          onClick={syncWithBrain}
        >
          Sync with brain
        </Button>
        <Button
          data-lalala-tpl-btn="ghost"
          aria-label={`${title}: refresh from data`}
          disabled={busy}
          onClick={refreshFromData}
        >
          Refresh
        </Button>
      </div>

      {status ? <div data-lalala-tpl-status="">{status}</div> : null}
    </div>
  );
}

type ChatMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: number;
};

const QUICK_STARTERS = [
  "Summarize what needs my attention today",
  "Check what agents are running",
  "Tidy this canvas",
] as const;

function ChatTemplateCard(props: { readonly instance: TemplateInstance }) {
  const { id: cardId, title } = props.instance;
  const [messages, setMessages] = useCardState<readonly ChatMessage[]>(
    cardId,
    "messages",
    [],
    Array.isArray,
  );
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sendMessage = async (rawText: string) => {
    const text = rawText.trim();
    if (text === "" || busy) return;
    const entry: ChatMessage = {
      id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      role: "user",
      text,
      at: Date.now(),
    };
    setMessages((prev) => [...prev.slice(-39), entry]);
    setDraft("");
    setBusy(true);
    try {
      const result = await dispatchTemplatePrompt(
        buildChatPrompt({ cardId, title, message: text }),
        { cardId, template: "chat", action: "send" },
      );
      setStatus(result.message);
    } finally {
      setBusy(false);
    }
  };

  const refreshReplies = async () => {
    setBusy(true);
    try {
      const data = await readTemplateCardData<{
        readonly reply?: unknown;
        readonly messages?: readonly { readonly role?: unknown; readonly text?: unknown; readonly at?: unknown }[];
      }>(cardId);
      if (!data) {
        setStatus("No saved replies yet — brain answers aloud in your call.");
        return;
      }
      if (Array.isArray(data.messages)) {
        const parsed: ChatMessage[] = data.messages.flatMap((entry, index) => {
          if (typeof entry?.text !== "string" || entry.text.trim() === "") return [];
          return [
            {
              id: `d-${index}`,
              role: entry.role === "assistant" ? "assistant" : "user",
              text: entry.text.trim(),
              at: typeof entry.at === "number" ? entry.at : Date.now(),
            },
          ];
        });
        setMessages(parsed.slice(-40));
        setStatus(`Loaded ${parsed.length} message${parsed.length === 1 ? "" : "s"}.`);
      } else if (typeof data.reply === "string" && data.reply.trim() !== "") {
        setMessages((prev) => [
          ...prev.slice(-39),
          {
            id: `r-${Date.now().toString(36)}`,
            role: "assistant",
            text: data.reply as string,
            at: Date.now(),
          },
        ]);
        setStatus("Pulled latest reply.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-lalala-tpl="chat">
      {messages.length === 0 ? (
        <div data-lalala-tpl-field="">
          <p data-lalala-tpl-empty="">
            Prompts go straight to your voice brain thread. Pick a starter or type below.
          </p>
          <div data-lalala-tpl-chips="">
            {QUICK_STARTERS.map((starter) => (
              <Button
                key={starter}
                data-lalala-tpl-chip=""
                aria-label={`${title}: send "${starter}"`}
                onClick={() => void sendMessage(starter)}
              >
                {starter}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <ul data-lalala-tpl-list="">
          {messages.map((msg) => (
            <li key={msg.id} data-lalala-tpl-msg={msg.role}>
              <header>
                <span>{msg.role === "user" ? "You" : "Brain"}</span>
                <time>{formatClock(msg.at)}</time>
              </header>
              <p>{msg.text}</p>
            </li>
          ))}
        </ul>
      )}

      <div data-lalala-tpl-field="">
        <Textarea
          data-lalala-tpl-textarea=""
          aria-label={`${title}: message`}
          placeholder="Message the brain… (Enter to send)"
          value={draft}
          autoResize
          submitShortcut="enter"
          onValueChange={setDraft}
          onSubmit={() => void sendMessage(draft)}
        />
        <div data-lalala-tpl-row="between">
          <div data-lalala-tpl-row="">
            <Button
              data-lalala-tpl-btn="ghost"
              aria-label={`${title}: refresh replies`}
              disabled={busy}
              onClick={refreshReplies}
            >
              Refresh
            </Button>
            {messages.length > 0 ? (
              <Button
                data-lalala-tpl-btn="danger"
                aria-label={`${title}: clear chat history`}
                data-agent-confirm={`Clears the local chat history in ${title}`}
                onClick={() => {
                  setMessages([]);
                  setStatus(null);
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
          <Button
            data-lalala-tpl-btn="primary"
            aria-label={`${title}: send message`}
            disabled={busy || draft.trim() === ""}
            onClick={() => void sendMessage(draft)}
          >
            Send
          </Button>
        </div>
      </div>

      {status ? <div data-lalala-tpl-status="">{status}</div> : null}
    </div>
  );
}

type MediaJob = {
  readonly id: string;
  readonly prompt: string;
  readonly meta: string;
  readonly status: "sent" | "local" | "ready";
  readonly at: number;
  readonly url?: string;
};

function ImageGenTemplateCard(props: { readonly instance: TemplateInstance }) {
  const { id: cardId, title } = props.instance;
  const [prompt, setPrompt] = useCardState<string>(cardId, "prompt", "");
  const [aspect, setAspect] = useCardState<ImageAspect>(
    cardId,
    "aspect",
    "1:1",
    (v) => (IMAGE_ASPECTS as readonly string[]).includes(v),
  );
  const [style, setStyle] = useCardState<ImageStyle>(
    cardId,
    "style",
    "auto",
    (v) => IMAGE_STYLES.some((s) => s.value === v),
  );
  const [jobs, setJobs] = useCardState<readonly MediaJob[]>(cardId, "jobs", [], Array.isArray);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    const clean = prompt.trim();
    if (clean === "" || busy) return;
    setBusy(true);
    try {
      const fullPrompt = buildImageGenPrompt({ cardId, title, prompt: clean, aspect, style });
      const result = await dispatchTemplatePrompt(fullPrompt, {
        cardId,
        template: "image-gen",
        action: "generate",
        data: { aspect, style },
      });
      const job: MediaJob = {
        id: `img-${Date.now().toString(36)}`,
        prompt: clean,
        meta: `${aspect} · ${style}`,
        status: result.ok ? "sent" : "local",
        at: Date.now(),
      };
      setJobs((prev) => [job, ...prev.slice(0, 11)]);
      setStatus(result.message);
    } finally {
      setBusy(false);
    }
  };

  const refreshAssets = async () => {
    setBusy(true);
    try {
      const data = await readTemplateCardData<{
        readonly url?: unknown;
        readonly prompt?: unknown;
        readonly images?: readonly { readonly url?: unknown; readonly prompt?: unknown; readonly at?: unknown }[];
      }>(cardId);
      const incoming: MediaJob[] = [];
      if (Array.isArray(data?.images)) {
        for (const [index, img] of data.images.entries()) {
          if (typeof img?.url !== "string" || img.url.trim() === "") continue;
          incoming.push({
            id: `asset-${index}-${img.url.slice(-8)}`,
            prompt: typeof img.prompt === "string" ? img.prompt : "Generated image",
            meta: "ready",
            status: "ready",
            at: typeof img.at === "number" ? img.at : Date.now(),
            url: img.url.trim(),
          });
        }
      } else if (typeof data?.url === "string" && data.url.trim() !== "") {
        incoming.push({
          id: `asset-${Date.now().toString(36)}`,
          prompt: typeof data.prompt === "string" ? data.prompt : "Generated image",
          meta: "ready",
          status: "ready",
          at: Date.now(),
          url: data.url.trim(),
        });
      }
      if (incoming.length === 0) {
        setStatus("No generated images in card data yet.");
        return;
      }
      setJobs((prev) => {
        const seen = new Set(incoming.map((j) => j.url));
        return [...incoming, ...prev.filter((j) => !j.url || !seen.has(j.url))].slice(0, 12);
      });
      setStatus(`Loaded ${incoming.length} image${incoming.length === 1 ? "" : "s"}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-lalala-tpl="image-gen">
      <div data-lalala-tpl-field="">
        <span data-lalala-tpl-label="">Prompt</span>
        <Textarea
          data-lalala-tpl-textarea=""
          aria-label={`${title}: image prompt`}
          placeholder="Describe the image you want to generate…"
          value={prompt}
          autoResize
          onValueChange={setPrompt}
        />
      </div>

      <div data-lalala-tpl-controls="">
        <div data-lalala-tpl-field="">
          <span data-lalala-tpl-label="">Aspect</span>
          <SegmentedControl
            data-lalala-tpl-seg=""
            aria-label={`${title}: aspect ratio`}
            value={aspect}
            onValueChange={(next) => setAspect(next as ImageAspect)}
          >
            {IMAGE_ASPECTS.map((ratio) => (
              <SegmentedControlItem
                key={ratio}
                value={ratio}
                aria-label={`${title}: aspect ${ratio}`}
              >
                {ratio}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>

        <div data-lalala-tpl-field="">
          <span data-lalala-tpl-label="">Style</span>
          <Select
            items={IMAGE_STYLES.map((s) => ({ value: s.value, label: s.label }))}
            value={style}
            onValueChange={(next) => {
              if (next !== null) setStyle(next as ImageStyle);
            }}
          >
            <SelectTrigger
              data-lalala-tpl-select-trigger=""
              aria-label={`${title}: style`}
            >
              <SelectValue placeholder="Style" />
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </SelectTrigger>
            <SelectContent data-lalala-tpl-select-content="">
              {IMAGE_STYLES.map((item) => (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  data-lalala-tpl-select-item=""
                >
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div data-lalala-tpl-row="between">
        <Button
          data-lalala-tpl-btn="primary"
          aria-label={`${title}: generate image`}
          disabled={busy || prompt.trim() === ""}
          onClick={generate}
        >
          Generate image
        </Button>
        <Button
          data-lalala-tpl-btn="ghost"
          aria-label={`${title}: refresh images`}
          disabled={busy}
          onClick={refreshAssets}
        >
          Refresh
        </Button>
      </div>

      {status ? <div data-lalala-tpl-status="">{status}</div> : null}

      {jobs.length > 0 ? (
        <div data-lalala-tpl-media="">
          {jobs.map((job) => (
            <figure key={job.id} data-lalala-tpl-asset="">
              {job.url ? <img src={job.url} alt={job.prompt} loading="lazy" /> : null}
              <figcaption>
                <span>{job.prompt}</span>
                <span data-lalala-tpl-meta="">
                  {job.meta} · {formatClock(job.at)}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p data-lalala-tpl-empty="">Generated images and queued prompts appear here.</p>
      )}
    </div>
  );
}

function VideoGenTemplateCard(props: { readonly instance: TemplateInstance }) {
  const { id: cardId, title } = props.instance;
  const [prompt, setPrompt] = useCardState<string>(cardId, "prompt", "");
  const [aspect, setAspect] = useCardState<VideoAspect>(
    cardId,
    "aspect",
    "16:9",
    (v) => (VIDEO_ASPECTS as readonly string[]).includes(v),
  );
  const [duration, setDuration] = useCardState<VideoDuration>(
    cardId,
    "duration",
    "5s",
    (v) => (VIDEO_DURATIONS as readonly string[]).includes(v),
  );
  const [motion, setMotion] = useCardState<VideoMotion>(
    cardId,
    "motion",
    "balanced",
    (v) => VIDEO_MOTIONS.some((m) => m.value === v),
  );
  const [jobs, setJobs] = useCardState<readonly MediaJob[]>(cardId, "jobs", [], Array.isArray);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    const clean = prompt.trim();
    if (clean === "" || busy) return;
    setBusy(true);
    try {
      const fullPrompt = buildVideoGenPrompt({
        cardId,
        title,
        prompt: clean,
        aspect,
        duration,
        motion,
      });
      const result = await dispatchTemplatePrompt(fullPrompt, {
        cardId,
        template: "video-gen",
        action: "generate",
        data: { aspect, duration, motion },
      });
      const job: MediaJob = {
        id: `vid-${Date.now().toString(36)}`,
        prompt: clean,
        meta: `${duration} · ${aspect} · ${motion}`,
        status: result.ok ? "sent" : "local",
        at: Date.now(),
      };
      setJobs((prev) => [job, ...prev.slice(0, 9)]);
      setStatus(result.message);
    } finally {
      setBusy(false);
    }
  };

  const refreshAssets = async () => {
    setBusy(true);
    try {
      const data = await readTemplateCardData<{
        readonly url?: unknown;
        readonly prompt?: unknown;
        readonly videos?: readonly { readonly url?: unknown; readonly prompt?: unknown; readonly at?: unknown }[];
      }>(cardId);
      const incoming: MediaJob[] = [];
      if (Array.isArray(data?.videos)) {
        for (const [index, video] of data.videos.entries()) {
          if (typeof video?.url !== "string" || video.url.trim() === "") continue;
          incoming.push({
            id: `vid-asset-${index}-${video.url.slice(-8)}`,
            prompt: typeof video.prompt === "string" ? video.prompt : "Generated clip",
            meta: "ready",
            status: "ready",
            at: typeof video.at === "number" ? video.at : Date.now(),
            url: video.url.trim(),
          });
        }
      } else if (typeof data?.url === "string" && data.url.trim() !== "") {
        incoming.push({
          id: `vid-asset-${Date.now().toString(36)}`,
          prompt: typeof data.prompt === "string" ? data.prompt : "Generated clip",
          meta: "ready",
          status: "ready",
          at: Date.now(),
          url: data.url.trim(),
        });
      }
      if (incoming.length === 0) {
        setStatus("No generated clips in card data yet.");
        return;
      }
      setJobs((prev) => {
        const seen = new Set(incoming.map((j) => j.url));
        return [...incoming, ...prev.filter((j) => !j.url || !seen.has(j.url))].slice(0, 10);
      });
      setStatus(`Loaded ${incoming.length} clip${incoming.length === 1 ? "" : "s"}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-lalala-tpl="video-gen">
      <div data-lalala-tpl-field="">
        <span data-lalala-tpl-label="">Shot prompt</span>
        <Textarea
          data-lalala-tpl-textarea=""
          aria-label={`${title}: video prompt`}
          placeholder="Describe the shot, subject, and camera motion…"
          value={prompt}
          autoResize
          onValueChange={setPrompt}
        />
      </div>

      <div data-lalala-tpl-controls="">
        <div data-lalala-tpl-field="">
          <span data-lalala-tpl-label="">Aspect</span>
          <SegmentedControl
            data-lalala-tpl-seg=""
            aria-label={`${title}: aspect ratio`}
            value={aspect}
            onValueChange={(next) => setAspect(next as VideoAspect)}
          >
            {VIDEO_ASPECTS.map((ratio) => (
              <SegmentedControlItem
                key={ratio}
                value={ratio}
                aria-label={`${title}: aspect ${ratio}`}
              >
                {ratio}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>

        <div data-lalala-tpl-field="">
          <span data-lalala-tpl-label="">Length</span>
          <SegmentedControl
            data-lalala-tpl-seg=""
            aria-label={`${title}: duration`}
            value={duration}
            onValueChange={(next) => setDuration(next as VideoDuration)}
          >
            {VIDEO_DURATIONS.map((len) => (
              <SegmentedControlItem
                key={len}
                value={len}
                aria-label={`${title}: duration ${len}`}
              >
                {len}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>

        <div data-lalala-tpl-field="">
          <span data-lalala-tpl-label="">Motion</span>
          <Select
            items={VIDEO_MOTIONS.map((m) => ({ value: m.value, label: m.label }))}
            value={motion}
            onValueChange={(next) => {
              if (next !== null) setMotion(next as VideoMotion);
            }}
          >
            <SelectTrigger
              data-lalala-tpl-select-trigger=""
              aria-label={`${title}: camera motion`}
            >
              <SelectValue placeholder="Motion" />
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </SelectTrigger>
            <SelectContent data-lalala-tpl-select-content="">
              {VIDEO_MOTIONS.map((item) => (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  data-lalala-tpl-select-item=""
                >
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div data-lalala-tpl-row="between">
        <Button
          data-lalala-tpl-btn="primary"
          aria-label={`${title}: generate video`}
          disabled={busy || prompt.trim() === ""}
          onClick={generate}
        >
          Generate video
        </Button>
        <Button
          data-lalala-tpl-btn="ghost"
          aria-label={`${title}: refresh videos`}
          disabled={busy}
          onClick={refreshAssets}
        >
          Refresh
        </Button>
      </div>

      {status ? <div data-lalala-tpl-status="">{status}</div> : null}

      {jobs.length > 0 ? (
        <div data-lalala-tpl-media="">
          {jobs.map((job) => (
            <figure key={job.id} data-lalala-tpl-asset="">
              {job.url ? <video src={job.url} controls playsInline preload="metadata" /> : null}
              <figcaption>
                <span>{job.prompt}</span>
                <span data-lalala-tpl-meta="">
                  {job.meta} · {formatClock(job.at)}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p data-lalala-tpl-empty="">Generated clips and queued shots appear here.</p>
      )}
    </div>
  );
}

function TemplateBody(props: { readonly instance: TemplateInstance }) {
  switch (props.instance.template) {
    case "todo":
      return <TodoTemplateCard instance={props.instance} />;
    case "chat":
      return <ChatTemplateCard instance={props.instance} />;
    case "image-gen":
      return <ImageGenTemplateCard instance={props.instance} />;
    case "video-gen":
      return <VideoGenTemplateCard instance={props.instance} />;
  }
}

/** Built-in template cards spawned by the user or the brain; synced across devices via canvasStore. */
export function TemplateCards() {
  const instances = useSyncExternalStore(subscribeTemplates, getActiveTemplates);
  return instances.map((instance) => (
    <CanvasCard
      key={instance.id}
      id={instance.id}
      title={instance.title}
      at={{ x: 40, y: 40, w: instance.w, h: instance.h }}
      onRemove={() => removeTemplate(instance.id)}
      {...(instance.canvas ? { canvas: instance.canvas } : {})}
    >
      <TemplateBody instance={instance} />
    </CanvasCard>
  ));
}
