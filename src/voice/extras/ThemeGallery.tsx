import { useState } from "react";
import { type LookId, setLook, useLook } from "./look";
import "./themeGallery.css";

// Previews of lalala.talk's own start page in each theme, served from public/themes/.
const THEMES: readonly {
  readonly id: LookId;
  readonly name: string;
  readonly note: string;
}[] = [
  { id: "neon", name: "Cyberpunk", note: "Neon green on black, sharp edges, the original." },
  { id: "paper", name: "Paper notebook", note: "Taped index cards, coloured pencils, warm paper." },
  { id: "t3", name: "T3 Code", note: "Dressed as T3 Code itself: its surfaces, borders and blue accent." },
];

/** The theme switcher: a preview of each look, the one in use marked, Use on the others. */
export function ThemeGallery() {
  const look = useLook();
  const [announcement, setAnnouncement] = useState("");
  const choose = (theme: (typeof THEMES)[number], control: HTMLElement) => {
    if (theme.id === look) return;
    setLook(theme.id);
    setAnnouncement(`${theme.name} theme in use`);
    control.closest("li")?.querySelector("h3")?.focus({ preventScroll: true });
  };

  return (
    <>
      <span data-theme-announcement="" role="status">
        {announcement}
      </span>
      <ul data-lalala-themes="">
        {THEMES.map((theme) => {
          const on = look === theme.id;
          return (
            <li
              key={theme.id}
              data-on={on || undefined}
              onClick={(event) => {
                if (!(event.target instanceof Element) || event.target.closest("button")) return;
                choose(theme, event.currentTarget);
              }}
            >
              <img
                data-theme-preview=""
                src={`/themes/${theme.id}.jpg`}
                srcSet={`/themes/${theme.id}.jpg 1x, /themes/${theme.id}-2x.webp 2x`}
                alt=""
                loading="lazy"
              />
              <div data-theme-text="">
                <h3 tabIndex={-1}>{theme.name}</h3>
                <span>{theme.note}</span>
              </div>
              <div data-theme-actions="">
                <div data-theme-choice="">
                  <span data-theme-current="">
                    <span aria-hidden="true">✓</span> In use
                  </span>
                  <button
                    type="button"
                    data-lalala-settings-button=""
                    data-quiet=""
                    aria-label={`Use the ${theme.name} theme`}
                    onClick={(event) => choose(theme, event.currentTarget)}
                  >
                    Use
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
