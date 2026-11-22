// Built-in card templates (registry, prompt dispatch, data bridge, canvasLayout persistence, docs).
// Run: node --experimental-strip-types --test scripts/templates/check.test.mjs
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";

import {
  CARD_TEMPLATES,
  TEMPLATE_IDS,
  buildChatPrompt,
  buildImageGenPrompt,
  buildTodoSyncPrompt,
  buildVideoGenPrompt,
  createTemplateInstance,
  dispatchTemplatePrompt,
  getTemplate,
  isTemplateId,
  nextTemplateCardId,
  readTemplateCardData,
  resolveTemplateId,
  sanitizeTemplates,
} from "../../src/voice/templates/registry.ts";
import { readCanvasLayout, saveCanvasCards } from "../../vite/canvasLayout.ts";

test("registry exposes todo, chat, image-gen, and video-gen templates with aliases", () => {
  assert.deepEqual([...TEMPLATE_IDS], ["todo", "chat", "image-gen", "video-gen"]);
  assert.equal(CARD_TEMPLATES.length, 4);
  for (const id of TEMPLATE_IDS) {
    assert.equal(isTemplateId(id), true);
    const meta = getTemplate(id);
    assert.ok(meta);
    assert.ok(meta.defaultSize.w >= 320 && meta.defaultSize.h >= 360);
    assert.ok(meta.voiceHints.length > 0);
  }
  assert.equal(isTemplateId("unknown"), false);
  assert.equal(resolveTemplateId("Todo List"), "todo");
  assert.equal(resolveTemplateId("quick_chat"), "chat");
  assert.equal(resolveTemplateId("image"), "image-gen");
  assert.equal(resolveTemplateId("videogen"), "video-gen");
  assert.equal(resolveTemplateId("nope"), undefined);
});

test("createTemplateInstance picks collision-free card ids and clamps bounds", () => {
  const first = createTemplateInstance("todo", { now: 1_000 });
  assert.equal(first.id, "todo");
  assert.equal(first.title, "Todo");
  assert.equal(first.w, 360);
  assert.equal(first.h, 420);

  const second = createTemplateInstance("todo", {
    existingIds: ["todo", "todo-2"],
    canvas: "c2",
    w: 50,
    h: 9999,
    now: 2_000,
  });
  assert.equal(second.id, "todo-3");
  assert.equal(second.canvas, "c2");
  assert.equal(second.w, 160);
  assert.equal(second.h, 900);

  assert.equal(nextTemplateCardId("chat", ["Daily-Chat"], "Daily Chat!"), "daily-chat-2");
});

test("prompt builders reference card ids and cards/<id>.data.json contracts", () => {
  const todo = buildTodoSyncPrompt({
    cardId: "today-todo",
    title: "Today",
    openItems: ["Ship M3", "Review PR"],
  });
  assert.match(todo, /today-todo/);
  assert.match(todo, /cards\/today-todo\.data\.json/);
  assert.match(todo, /Ship M3/);

  const chat = buildChatPrompt({ cardId: "chat", title: "Quick Chat", message: "status?" });
  assert.equal(chat, '[from card "Quick Chat" (id: chat)] status?');

  const img = buildImageGenPrompt({
    cardId: "art-1",
    title: "Image Gen",
    prompt: "sunset robot",
    aspect: "16:9",
    style: "illustration",
  });
  assert.match(img, /sunset robot/);
  assert.match(img, /16:9/);
  assert.match(img, /illustration/);
  assert.match(img, /cards\/art-1\.data\.json/);

  const vid = buildVideoGenPrompt({
    cardId: "clip-1",
    title: "Video Gen",
    prompt: "slow drone over mountains",
    aspect: "9:16",
    duration: "8s",
    motion: "subtle",
  });
  assert.match(vid, /8s/);
  assert.match(vid, /9:16/);
  assert.match(vid, /subtle/);
  assert.match(vid, /cards\/clip-1\.data\.json/);
});

test("dispatchTemplatePrompt and readTemplateCardData wire cleanly to globals", async () => {
  const prevSend = globalThis.__lalalaSendTyped;
  const prevLog = globalThis.__lalalaLog;
  const prevAdapters = globalThis.__lalalaAdapters;
  const logged = [];
  const sent = [];
  try {
    globalThis.__lalalaLog = (who, type, data) => logged.push({ who, type, data });
    globalThis.__lalalaSendTyped = async (text) => {
      sent.push(text);
      return true;
    };
    const ok = await dispatchTemplatePrompt("hello brain", {
      cardId: "chat",
      template: "chat",
      action: "send",
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.via, "typed");
    assert.deepEqual(sent, ["hello brain"]);
    assert.equal(logged.at(-1).type, "card.log");
    assert.equal(logged.at(-1).data.id, "chat");

    // Offline / no brain fallback stays graceful.
    globalThis.__lalalaSendTyped = undefined;
    const offline = await dispatchTemplatePrompt("offline test", {
      cardId: "todo",
      template: "todo",
      action: "sync",
    });
    assert.equal(offline.ok, false);
    assert.equal(offline.via, "log");

    // Data reader reads cards/<id>.data.json via host adapter.
    globalThis.__lalalaAdapters = {
      readFile: async (path) =>
        path === "cards/todo.data.json"
          ? JSON.stringify({ items: [{ id: "1", text: "Ship templates", done: false }] })
          : null,
    };
    const data = await readTemplateCardData("todo");
    assert.deepEqual(data, { items: [{ id: "1", text: "Ship templates", done: false }] });
    assert.equal(await readTemplateCardData("missing"), null);
  } finally {
    globalThis.__lalalaSendTyped = prevSend;
    globalThis.__lalalaLog = prevLog;
    globalThis.__lalalaAdapters = prevAdapters;
  }
});

test("canvasLayout persists spawned templates, validates input, and syncs null tombstones", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lalala-templates-layout-"));
  const prev = process.env.LALALA_CANVAS_FILE;
  process.env.LALALA_CANVAS_FILE = NodePath.join(dir, "canvas.json");
  try {
    const todo = createTemplateInstance("todo", { title: "Today", now: 100 });
    const video = createTemplateInstance("video-gen", {
      id: "promo-video",
      canvas: "c2",
      now: 200,
    });
    const saved = saveCanvasCards(
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        [todo.id]: todo,
        [video.id]: video,
        "bad id with spaces": todo,
        invalid: { id: "invalid", template: "not-a-template", title: "Bad", w: 300, h: 300, createdAt: 1 },
      },
    );
    assert.deepEqual(Object.keys(saved.templates).sort(), ["promo-video", "todo"]);
    assert.equal(saved.templates.todo?.template, "todo");
    assert.equal(saved.templates["promo-video"]?.canvas, "c2");

    // Tombstone removal persists on readCanvasLayout.
    saveCanvasCards({}, undefined, undefined, undefined, undefined, undefined, { todo: null });
    const reloaded = readCanvasLayout();
    assert.equal(reloaded.templates.todo, null);
    assert.equal(reloaded.templates["promo-video"]?.template, "video-gen");

    // Registry sanitizer drops oversized config blobs cleanly.
    const sanitized = sanitizeTemplates({
      chat: {
        id: "chat",
        template: "chat",
        title: "Chat",
        w: 380,
        h: 440,
        createdAt: 10,
        config: { huge: "x".repeat(12_000) },
      },
    });
    assert.equal(sanitized.chat?.config, undefined);
  } finally {
    if (prev === undefined) delete process.env.LALALA_CANVAS_FILE;
    else process.env.LALALA_CANVAS_FILE = prev;
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

test("brain-cards.md and brain-files.md document all built-in template IDs", () => {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  for (const rel of ["src/voice/brain-cards.md", "src/voice/brain-files.md"]) {
    const text = NodeFS.readFileSync(NodePath.join(root, rel), "utf8");
    for (const id of TEMPLATE_IDS) {
      assert.ok(text.includes(`\`${id}\``), `${rel} should document template id \`${id}\``);
    }
    assert.match(text, /\[card template="/);
  }
});
