export const PET_CELL_WIDTH = 192;
export const PET_CELL_HEIGHT = 208;
export const PET_COLUMNS = 8;
export const PET_ROWS = 11;
/** Logical overlay width reserved for the glass status bubble. */
export const PET_BUBBLE_WIDTH = 420;
/** Fixed logical space above the sprite for the two-line status bubble. */
export const PET_BUBBLE_HEIGHT = 64;

export type PetStatus = "idle" | "running" | "waiting" | "failed" | "review";
export type PetAnimation = PetStatus | "stand" | "rest" | "lay" | "jump";

/** Standard Codex v2 rows. Rows 9 and 10 are the 16 clockwise directions. */
export const PET_STATUS_ROWS: Record<PetStatus, number> = {
  idle: 0,
  running: 7,
  waiting: 6,
  failed: 5,
  review: 8,
};

/** Codex v2 action rows used for local interaction/idle behavior. */
export const PET_ANIMATION_ROWS: Record<Exclude<PetAnimation, "idle">, number> = {
  running: 7,
  waiting: 6,
  failed: 5,
  review: 8,
  stand: 0,
  rest: 4,
  lay: 5,
  jump: 3,
};

export interface PetAtlasPackage {
  id: string;
  displayName: string;
  description: string;
  spriteVersionNumber: number;
  spritesheetPath: string;
  spritesheetDataUrl: string;
}

export function atlasFrame(
  status: PetAnimation,
  frame: number,
  lookDirection = 0,
  frameCounts?: readonly number[],
): { row: number; column: number } {
  if (status === "idle") {
    const direction = ((lookDirection % 16) + 16) % 16;
    return { row: 9 + Math.floor(direction / 8), column: direction % 8 };
  }
  const row = PET_ANIMATION_ROWS[status];
  const frameCount = Math.max(1, Math.min(PET_COLUMNS, frameCounts?.[row] ?? PET_COLUMNS));
  return { row, column: ((frame % frameCount) + frameCount) % frameCount };
}

export function atlasBackgroundPosition(
  status: PetAnimation,
  frame: number,
  lookDirection = 0,
  frameCounts?: readonly number[],
  scale = 1,
): string {
  const { row, column } = atlasFrame(status, frame, lookDirection, frameCounts);
  return `${-column * PET_CELL_WIDTH * scale}px ${-row * PET_CELL_HEIGHT * scale}px`;
}
