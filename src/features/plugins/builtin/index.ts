import type { LoadablePlugin } from "../runtime/loader";

/** Builtin plugins ship compiled with the host and load through the normal
 *  pipeline at bootstrap. Currently empty: the first plugin (usage-stats)
 *  ships as a real external plugin in its own repo, per the decoupling rule
 *  (plan ADR-2/ADR-4 — plugins live on GitHub, not in the host tree). */
export const BUILTIN_PLUGINS: LoadablePlugin[] = [];
