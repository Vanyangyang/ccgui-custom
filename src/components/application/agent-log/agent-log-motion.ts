/**
 * Motion tuning for the agent log, split out of agent-log.tsx so the
 * component module exports components only.
 */

export const SOFT_EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Each unit blurs in as it lands: 6px of blur and a 4px lift resolving over
 * 0.42s, the same language the AI Chat thread uses for a streaming line. The
 * height runs a touch shorter on the soft curve so the row has finished making
 * space slightly before the text finishes sharpening — the container settles
 * first, then the words arrive, which is what reads as smooth rather than as a
 * jump.
 *
 * Growing a row from height 0 means `overflow-hidden` cuts a hard line through
 * the text while it emerges. `--bui-reveal-fade` softens that edge: the row is
 * masked with a gradient whose solid portion ends that many pixels short of the
 * bottom, and the reveal animates it to 0, at which point the mask is a no-op
 * and nothing pops. The fade is longer than a text line, so a row is always
 * faintest exactly where it is being clipped.
 */
export const REVEAL_FADE_VAR = "--bui-reveal-fade";

export const UNIT_INITIAL = {
  opacity: 0,
  height: 0,
  y: 4,
  filter: "blur(6px)",
  [REVEAL_FADE_VAR]: "22px",
};

export const UNIT_ANIMATE = {
  opacity: 1,
  height: "auto",
  y: 0,
  filter: "blur(0px)",
  [REVEAL_FADE_VAR]: "0px",
};

export const UNIT_TRANSITION = {
  height: { duration: 0.38, ease: SOFT_EASE },
  opacity: { duration: 0.42, ease: SOFT_EASE },
  filter: { duration: 0.42, ease: SOFT_EASE },
  y: { duration: 0.42, ease: SOFT_EASE },
  [REVEAL_FADE_VAR]: { duration: 0.44, ease: SOFT_EASE },
};
