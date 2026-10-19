import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ipc, type AppSettings, type PetPackage } from "@/lib/ipc";
import {
  atlasBackgroundPosition,
  PET_BUBBLE_HEIGHT,
  PET_BUBBLE_WIDTH,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
  type PetAnimation,
  type PetStatus,
} from "./pet-atlas";
import type { PetActivity } from "./pet-state";
import {
  DEFAULT_PET_SCALE,
  normalizePetScale,
  PET_BASE_SCALE,
  PET_SCALE_OPTIONS,
} from "./pet-scale";

interface NativePetState {
  sessionKey: string | null;
  sessionName: string | null;
  status: PetStatus;
  activity: PetActivity;
  lookDirection: number;
  cursorNearby: boolean;
  cursorOver: boolean;
  changedAt: number;
}

const DEFAULT_STATE: NativePetState = {
  sessionKey: null,
  sessionName: null,
  status: "idle",
  activity: "idle",
  lookDirection: 0,
  cursorNearby: false,
  cursorOver: false,
  changedAt: 0,
};

const IDLE_ANIMATIONS: readonly PetAnimation[] = ["stand", "rest", "lay"];

/** Localized bubble text for the native activity feed; idle has no label. */
function activityLabel(t: TFunction, activity: PetActivity): string {
  switch (activity) {
    case "thinking":
      return t("settings.petActivityThinking");
    case "tool":
      return t("settings.petActivityTool");
    case "command":
      return t("settings.petActivityCommand");
    case "waiting":
      return t("settings.petActivityWaiting");
    case "failed":
      return t("settings.petActivityFailed");
    case "completed":
      return t("settings.petActivityCompleted");
    default:
      return "";
  }
}

/** The overlay inherits the app's themed body; blank both so the transparent
 *  window shows only the sprite and bubble. */
function useTransparentHostWindow() {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previous = {
      rootBackground: root.style.background,
      bodyBackground: body.style.background,
      bodyOverflow: body.style.overflow,
    };
    root.style.background = "transparent";
    body.style.background = "transparent";
    body.style.overflow = "hidden";
    return () => {
      root.style.background = previous.rootBackground;
      body.style.background = previous.bodyBackground;
      body.style.overflow = previous.bodyOverflow;
    };
  }, []);
}

/** Native `pet://` state + the package/settings load. Scale is owned here
 *  because the host pushes its own scale on `pet://scale`. */
function usePetOverlayState() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [pet, setPet] = useState<PetPackage | null>(null);
  const [state, setState] = useState(DEFAULT_STATE);
  const [scale, setScale] = useState(DEFAULT_PET_SCALE);
  const scaleRef = useRef(DEFAULT_PET_SCALE);

  const applyScale = useCallback((value: number | undefined) => {
    const next = normalizePetScale(value);
    scaleRef.current = next;
    setScale(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unlistenState = listen<NativePetState>("pet://state", (event) => {
      setState({ ...DEFAULT_STATE, ...event.payload });
    });
    const unlistenScale = listen<number>("pet://scale", (event) => {
      const next = applyScale(event.payload);
      setSettings((current) => (current ? { ...current, petScale: next } : current));
    });
    void (async () => {
      try {
        const next = await ipc.getAppSettings();
        const petId = next.petId?.trim();
        // The native host only creates this window with a pet selected; with
        // none there is nothing to render (and nothing localized to show).
        if (!petId) {
          console.warn("[pet-overlay] no pet selected, staying hidden");
          return;
        }
        const packageData = await ipc.getPetPackage(petId);
        if (cancelled) return;
        setSettings(next);
        setPet(packageData);
        applyScale(next.petScale);
        // Visibility is owned by the Rust host: pet_set_visible shows the
        // window once state is emitted. No JS show() here — the capability
        // set deliberately does not grant it.
      } catch (error) {
        console.error("[pet-overlay] load failed", error);
      }
    })();
    return () => {
      cancelled = true;
      void unlistenState.then((dispose) => dispose());
      void unlistenScale.then((dispose) => dispose());
    };
  }, [applyScale]);

  /** Cycle to the next preset scale; a failed native call rolls back. */
  const cycleScale = useCallback(async () => {
    const current = scaleRef.current;
    const currentIndex = PET_SCALE_OPTIONS.findIndex((value) => Math.abs(value - current) < 0.001);
    const next = PET_SCALE_OPTIONS[(currentIndex + 1) % PET_SCALE_OPTIONS.length];
    applyScale(next);
    try {
      const applied = await ipc.setPetScale(next);
      applyScale(applied);
    } catch (error) {
      applyScale(current);
      console.warn("[pet-overlay] resize failed", error);
    }
  }, [applyScale]);

  return { settings, pet, state, scale, cycleScale };
}

function usePrefersReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reducedMotion;
}

/** Random idle pose while the pet is inactive; re-rolls on a slow timer. */
function useIdleAnimation(active: boolean): PetAnimation {
  const [idleAnimation, setIdleAnimation] = useState<PetAnimation>("stand");
  useEffect(() => {
    if (!active) return;
    let timer: number | null = null;
    const changeIdleAnimation = () => {
      setIdleAnimation((current) => {
        const candidates = IDLE_ANIMATIONS.filter((candidate) => candidate !== current);
        return candidates[Math.floor(Math.random() * candidates.length)] ?? "stand";
      });
      timer = window.setTimeout(changeIdleAnimation, 2800 + Math.random() * 3200);
    };
    changeIdleAnimation();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [active]);
  return idleAnimation;
}

/** Sprite frame ticker: resets when the activity/cursor/status context
 *  changes and steps at a cadence derived from the current animation. */
function usePetFrame({
  animation,
  reducedMotion,
  status,
  activity,
  cursorNearby,
  cursorOver,
}: {
  animation: PetAnimation;
  reducedMotion: boolean;
  status: PetStatus;
  activity: PetActivity;
  cursorNearby: boolean;
  cursorOver: boolean;
}): number {
  const contextKey = `${activity}|${cursorNearby}|${cursorOver}|${status}`;
  const [frame, setFrame] = useState(0);
  const [prevContextKey, setPrevContextKey] = useState(contextKey);
  // React's adjust-state-during-render pattern (an effect would paint one
  // stale atlas frame first): a new activity/cursor/status context restarts
  // the animation from its first frame.
  if (contextKey !== prevContextKey) {
    setPrevContextKey(contextKey);
    setFrame(0);
  }

  useEffect(() => {
    const frameDelay = reducedMotion
      ? 420
      : animation === "jump"
        ? 125
        : animation === "lay"
          ? 420
          : status === "waiting"
            ? 520
            : 180;
    const id = window.setInterval(() => setFrame((value) => value + 1), frameDelay);
    return () => window.clearInterval(id);
  }, [animation, reducedMotion, status]);

  return frame;
}

/** Status bubble above the sprite; `text` is the composed aria-live line. */
function PetBubble({
  text,
  activityText,
  sessionName,
}: {
  text: string;
  activityText: string;
  sessionName: string;
}) {
  return (
    <div
      className={`pet-bubble${text ? " pet-bubble-visible" : ""}`}
      aria-live="polite"
      aria-hidden={!text}
      aria-label={text || undefined}
    >
      {sessionName ? <span className="pet-bubble-session">{sessionName}</span> : null}
      <span className="pet-bubble-status">{activityText}</span>
    </div>
  );
}

/** The pet itself. A real button so the scale-cycle interaction is reachable
 *  by keyboard (Enter/Space); `data-tauri-drag-region` keeps window dragging. */
function PetSprite({
  pet,
  renderScale,
  backgroundPosition,
  onSavePosition,
  onCycleScale,
}: {
  pet: PetPackage;
  renderScale: number;
  backgroundPosition: string;
  onSavePosition: () => void;
  onCycleScale: () => void;
}) {
  return (
    <button
      type="button"
      data-tauri-drag-region
      className="pet-sprite outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      aria-label={pet.description || pet.displayName}
      style={{
        position: "absolute",
        left: ((PET_BUBBLE_WIDTH - PET_CELL_WIDTH) / 2) * renderScale,
        bottom: 0,
        width: PET_CELL_WIDTH * renderScale,
        height: PET_CELL_HEIGHT * renderScale,
        backgroundImage: `url(${pet.spritesheetDataUrl})`,
        backgroundSize: `${PET_CELL_WIDTH * 8 * renderScale}px ${PET_CELL_HEIGHT * 11 * renderScale}px`,
        backgroundPosition,
      }}
      onMouseUp={onSavePosition}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onCycleScale();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onCycleScale();
        }
      }}
    />
  );
}

export default function PetOverlayApp() {
  const { t } = useTranslation();
  useTransparentHostWindow();
  const { settings, pet, state, scale, cycleScale } = usePetOverlayState();
  const reducedMotion = usePrefersReducedMotion();
  const idleActive =
    state.status === "idle" && !state.cursorNearby && !state.cursorOver;
  const idleAnimation = useIdleAnimation(idleActive);
  const renderScale = PET_BASE_SCALE * scale;

  const animation = useMemo<PetAnimation>(() => {
    if (state.cursorOver) return "jump";
    if (state.status !== "idle") return state.status;
    if (state.cursorNearby) return "idle";
    return idleAnimation;
  }, [idleAnimation, state.cursorNearby, state.cursorOver, state.status]);

  const frame = usePetFrame({
    animation,
    reducedMotion,
    status: state.status,
    activity: state.activity,
    cursorNearby: state.cursorNearby,
    cursorOver: state.cursorOver,
  });

  const backgroundPosition = useMemo(
    () => atlasBackgroundPosition(animation, frame, state.lookDirection, pet?.frameCounts, renderScale),
    [animation, frame, pet?.frameCounts, renderScale, state.lookDirection],
  );

  const savePosition = async () => {
    try {
      const window = getCurrentWindow();
      const position = await window.outerPosition();
      const dpi = await window.scaleFactor();
      await ipc.savePetPosition({
        x: position.x / dpi + ((PET_BUBBLE_WIDTH - PET_CELL_WIDTH) / 2) * renderScale,
        y: position.y / dpi + PET_BUBBLE_HEIGHT,
      });
    } catch (error) {
      console.warn("[pet-overlay] position save failed", error);
    }
  };

  if (!pet || !settings) return null;

  const activityText = activityLabel(t, state.activity);
  const sessionName = state.sessionName?.trim() ?? "";
  const bubbleText = activityText
    ? sessionName
      ? t("settings.petActivityWithSession", {
          session: sessionName,
          status: activityText,
        })
      : activityText
    : "";

  return (
    <main
      aria-label={pet.displayName}
      className="pet-overlay"
      data-tauri-drag-region
      style={{
        width: PET_BUBBLE_WIDTH * renderScale,
        height: PET_CELL_HEIGHT * renderScale + PET_BUBBLE_HEIGHT,
      }}
    >
      <PetBubble
        text={bubbleText}
        activityText={activityText}
        sessionName={sessionName}
      />
      <PetSprite
        pet={pet}
        renderScale={renderScale}
        backgroundPosition={backgroundPosition}
        onSavePosition={() => void savePosition()}
        onCycleScale={() => void cycleScale()}
      />
    </main>
  );
}
