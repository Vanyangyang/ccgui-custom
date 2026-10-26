/** Supplementary plugin guidance, separate from user turns. It does not grant
 * tools or permissions. Supported local Claude/Codex launches restore it through
 * their native system/developer instruction channel, including resumed sessions.
 * Omission on a continuation retains the previous profile. Changing a profile
 * waits for a full native turn; it cannot replace instructions in a live turn. */
export interface HostFixedInstructions {
  /** Stable policy revision: [A-Za-z0-9._:-]{1,128}. */
  version: string;
  /** Nonblank text, at most 16000 UTF-16 units; NUL is forbidden. */
  text: string;
}
