import { useEffect, useState, useSyncExternalStore } from "react";

import { CanvasCard } from "./CanvasCard";
import {
  boxKey,
  getActiveTemplates,
  getCanvases,
  getView,
  isLayoutReady,
  isMounted,
  mountedUserCardCount,
  spawnTemplate,
  subscribe,
  subscribeCanvases,
  subscribeTemplates,
} from "./canvasStore";
import {
  DEFAULT_STARTER_IDS,
  STARTER_CARD_ID,
  STARTER_PRESETS,
  closeStarterState,
  isAgentMonitorPinnedOn,
  isOnboardingDismissed,
  isStarterForcedOpen,
  pinAgentMonitorFromStarter,
  presetsToSpawn,
  readStoredBrainCardIds,
  setOnboardingDismissedFromExtras,
  shouldShowStarter,
  starterAt,
  starterCardHtml,
  subscribeOnboarding,
  subscribeStarter,
  toggleStarterSelection,
} from "./starterLogic";
import "./starterCard.css";

const subscribeCards = (listener: () => void) => {
  const stopStore = subscribe(listener);
  const stopTemplates = subscribeTemplates(listener);
  const onEvent = () => listener();
  document.addEventListener("lalala:brain-cards", onEvent);
  document.addEventListener("lalala:agent-monitor", onEvent);
  return () => {
    stopStore();
    stopTemplates();
    document.removeEventListener("lalala:brain-cards", onEvent);
    document.removeEventListener("lalala:agent-monitor", onEvent);
  };
};

function StarterPicker(props: {
  readonly activeCanvas: string;
  readonly forcedOpen: boolean;
  readonly onDismiss: () => void;
}) {
  const { activeCanvas, forcedOpen, onDismiss } = props;
  const existingKey = useSyncExternalStore(
    subscribeCards,
    () => {
      const stored = readStoredBrainCardIds();
      const activeTemplates = getActiveTemplates();
      return STARTER_PRESETS.filter((preset) => {
        if (isMounted(boxKey(activeCanvas, preset.id))) return true;
        if (preset.id === "agent-monitor" && isAgentMonitorPinnedOn(activeCanvas)) return true;
        if (
          preset.template &&
          activeTemplates.some(
            (tpl) =>
              (tpl.canvas ?? "main") === activeCanvas &&
              (tpl.id === preset.id || tpl.template === preset.template),
          )
        ) {
          return true;
        }
        return stored.has(preset.id);
      })
        .map((preset) => preset.id)
        .join(",");
    },
    () => "",
  );
  const existingIds = new Set(existingKey ? existingKey.split(",") : []);

  const [selected, setSelected] = useState<ReadonlyArray<string>>(() => {
    const freshDefaults = DEFAULT_STARTER_IDS.filter((id) => !existingIds.has(id));
    return freshDefaults.length > 0 ? freshDefaults : DEFAULT_STARTER_IDS;
  });

  const toAdd = presetsToSpawn(selected, existingIds);
  const alreadyPickedCount = selected.filter((id) => existingIds.has(id)).length;
  const totalPicked = selected.length;

  const handleAdd = () => {
    const cardsApi = globalThis.__lalalaCards;
    let firstSpawnedId: string | undefined;
    for (const preset of toAdd) {
      if (preset.template) {
        const spawned = spawnTemplate(preset.template, {
          id: preset.id,
          title: preset.title,
          w: preset.w,
          h: preset.h,
          ...(activeCanvas !== "main" ? { canvas: activeCanvas } : {}),
        });
        firstSpawnedId ??= spawned.id;
      } else if (preset.id === "agent-monitor") {
        pinAgentMonitorFromStarter(activeCanvas);
        firstSpawnedId ??= preset.id;
      } else {
        cardsApi?.put(preset.id, {
          title: preset.title,
          w: preset.w,
          h: preset.h,
          html: starterCardHtml(preset),
          ...(activeCanvas !== "main" ? { canvas: activeCanvas } : {}),
        });
        firstSpawnedId ??= preset.id;
      }
    }
    const focusTarget = firstSpawnedId ?? toAdd[0]?.id ?? selected[0];
    onDismiss();
    if (focusTarget) {
      window.requestAnimationFrame(() => void globalThis.__lalalaCanvases?.focus?.(focusTarget));
    }
  };

  const addLabel =
    toAdd.length > 0
      ? `Add ${toAdd.length === 1 ? "1 card" : `${toAdd.length} cards`}`
      : alreadyPickedCount > 0
        ? "Show selected"
        : "Add selected";

  return (
    <div data-lalala-starter="">
      <div data-lalala-starter-head="">
        <h2>Start your canvas</h2>
        <p>Pick starter cards to drop on this canvas, or dismiss and start talking.</p>
      </div>
      <div data-lalala-starter-list="" role="group" aria-label="Starter cards">
        {STARTER_PRESETS.map((preset) => {
          const checked = selected.includes(preset.id);
          const added = existingIds.has(preset.id);
          return (
            <button
              key={preset.id}
              type="button"
              role="checkbox"
              aria-checked={checked}
              data-lalala-starter-item=""
              data-selected={checked ? "" : undefined}
              onClick={() => setSelected((prev) => toggleStarterSelection(prev, preset.id))}
            >
              <span data-lalala-starter-check="" aria-hidden="true">
                {checked ? (
                  <svg viewBox="0 0 16 16">
                    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
                  </svg>
                ) : null}
              </span>
              <span data-lalala-starter-copy="">
                <strong>{preset.title}</strong>
                <span>{preset.description}</span>
              </span>
              <span data-lalala-starter-tag="" data-added={added ? "" : undefined}>
                {added ? "Added" : preset.tag}
              </span>
            </button>
          );
        })}
      </div>
      <div data-lalala-starter-foot="">
        <button
          type="button"
          data-lalala-starter-primary=""
          disabled={totalPicked === 0}
          onClick={handleAdd}
        >
          {addLabel}
        </button>
        <button type="button" data-lalala-starter-ghost="" onClick={onDismiss}>
          {forcedOpen ? "Close" : "Start blank"}
        </button>
      </div>
      <p data-lalala-starter-hint="">Re-open anytime from the Canvases menu.</p>
    </div>
  );
}

/**
 * First-run onboarding & starter selector card: auto-mounts centred above the bar when the local
 * app opens with 0 cards on Main, and re-opens on demand from CanvasSwitcher.
 */
export function StarterCard(props: { readonly enabled: boolean }) {
  // Waits one commit so sibling CanvasCards run mountCard() before checking empty-canvas state.
  const [settled, setSettled] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for sibling cards' layout effects before deciding whether Main is empty
  useEffect(() => {
    setSettled(true);
  }, []);

  const { active } = useSyncExternalStore(subscribeCanvases, getCanvases);
  const layoutReady = useSyncExternalStore(subscribe, isLayoutReady, () => false);
  const userCardCount = useSyncExternalStore(
    subscribe,
    () => mountedUserCardCount(active, STARTER_CARD_ID),
    () => 0,
  );
  const dismissed = useSyncExternalStore(subscribeOnboarding, isOnboardingDismissed, () => false);
  const forcedOpen = useSyncExternalStore(subscribeStarter, isStarterForcedOpen, () => false);

  const visible =
    settled &&
    shouldShowStarter({
      enabled: props.enabled,
      layoutReady,
      activeCanvas: active,
      userCardCount,
      dismissed,
      forcedOpen,
    });

  if (!visible) return null;

  const view = getView();
  const at = starterAt(view.w || window.innerWidth, view.h || window.innerHeight);

  const handleDismiss = () => {
    closeStarterState();
    setOnboardingDismissedFromExtras(true);
  };

  return (
    <CanvasCard
      id={STARTER_CARD_ID}
      title="Starter"
      at={at}
      canvas={active}
      onRemove={handleDismiss}
    >
      <StarterPicker activeCanvas={active} forcedOpen={forcedOpen} onDismiss={handleDismiss} />
    </CanvasCard>
  );
}
