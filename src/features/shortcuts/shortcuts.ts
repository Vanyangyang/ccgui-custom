/**
 * 快捷键字符串协议层（自旧版 desktop-cc-gui 移植，去掉原生菜单桥接）。
 *
 * 字符串格式统一小写 `cmd+ctrl+alt+shift+key`：
 * - cmd/meta、ctrl/control、alt/option 同义；
 * - mac 精确比对四个修饰键；非 mac 把 cmd 映射到 ctrlKey，
 *   双写 cmd+ctrl 表示需同时按 Meta+Ctrl；
 * - shift 对 "+"/"_" 等 shifted 字符宽容（OPTIONAL_SHIFT_ALIASES）。
 */

export type ShortcutDefinition = {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

const MODIFIER_ORDER = ["cmd", "ctrl", "alt", "shift"] as const;
const MODIFIER_LABELS: Record<string, string> = {
  cmd: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
};
const MODIFIER_TEXT_LABELS = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
} as const;

const KEY_LABELS: Record<string, string> = {
  " ": "Space",
  space: "Space",
  escape: "Esc",
  enter: "↵",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

const SHIFTED_KEY_ALIASES: Record<string, string> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

const OPTIONAL_SHIFT_ALIASES: Record<string, true> = { "+": true, _: true };

const TEXT_KEY_LABELS: Record<string, string> = {
  " ": "Space",
  space: "Space",
  escape: "Esc",
  esc: "Esc",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
};

const MODIFIER_KEYS: Record<string, true> = { shift: true, control: true, alt: true, meta: true };
const KEY_ALIASES: Record<string, string> = {
  down: "arrowdown",
  esc: "escape",
  left: "arrowleft",
  return: "enter",
  right: "arrowright",
  up: "arrowup",
};

function formatShortcutKeyLabel(
  key: string,
  labels: Record<string, string>,
): string {
  return (
    labels[key] ??
    (key.length === 1 || /^f\d{1,2}$/.test(key) ? key.toUpperCase() : key)
  );
}

function normalizeKey(key: string): string | null {
  const normalized = key.toLowerCase();
  if (MODIFIER_KEYS[normalized]) {
    return null;
  }
  const shiftedAlias = SHIFTED_KEY_ALIASES[normalized];
  if (shiftedAlias) {
    return shiftedAlias;
  }
  if (normalized === " ") {
    return "space";
  }
  return KEY_ALIASES[normalized] ?? normalized;
}

function matchesShiftModifier(
  event: KeyboardEvent,
  parsed: ShortcutDefinition,
): boolean {
  if (parsed.shift === event.shiftKey) {
    return true;
  }
  return (
    !parsed.shift && event.shiftKey && OPTIONAL_SHIFT_ALIASES[event.key]
  );
}

export function parseShortcut(
  value: string | null | undefined,
): ShortcutDefinition | null {
  if (!value) {
    return null;
  }
  const parts = value
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const key = normalizeKey(parts[parts.length - 1] ?? "");
  if (!key || MODIFIER_KEYS[key]) {
    return null;
  }
  return {
    key,
    meta: parts.includes("cmd") || parts.includes("meta"),
    ctrl: parts.includes("ctrl") || parts.includes("control"),
    alt: parts.includes("alt") || parts.includes("option"),
    shift: parts.includes("shift"),
  };
}

export function formatShortcut(value: string | null | undefined): string {
  if (!value) {
    return "Not set";
  }
  const parsed = parseShortcut(value);
  if (!parsed) {
    return value;
  }
  const modifiers = MODIFIER_ORDER.flatMap((modifier) => {
    if (modifier === "cmd" && parsed.meta) {
      return MODIFIER_LABELS.cmd;
    }
    if (modifier === "ctrl" && parsed.ctrl) {
      return MODIFIER_LABELS.ctrl;
    }
    if (modifier === "alt" && parsed.alt) {
      return MODIFIER_LABELS.alt;
    }
    if (modifier === "shift" && parsed.shift) {
      return MODIFIER_LABELS.shift;
    }
    return [];
  });
  const keyLabel = formatShortcutKeyLabel(parsed.key, KEY_LABELS);
  return [...modifiers, keyLabel].join("");
}

export function formatShortcutForPlatform(
  value: string | null | undefined,
  isMac: boolean = isMacPlatform(),
): string {
  if (!value) {
    return "Not set";
  }
  const parsed = parseShortcut(value);
  if (!parsed) {
    return value;
  }
  if (isMac) {
    return formatShortcut(value);
  }
  const modifiers: string[] = [];
  if (parsed.meta && parsed.ctrl) {
    modifiers.push("Meta");
  } else if (parsed.meta) {
    modifiers.push(MODIFIER_TEXT_LABELS.ctrl);
  }
  if (parsed.ctrl) {
    modifiers.push(MODIFIER_TEXT_LABELS.ctrl);
  }
  if (parsed.alt) {
    modifiers.push(MODIFIER_TEXT_LABELS.alt);
  }
  if (parsed.shift) {
    modifiers.push(MODIFIER_TEXT_LABELS.shift);
  }
  const keyLabel = formatShortcutKeyLabel(parsed.key, TEXT_KEY_LABELS);
  return [...modifiers, keyLabel].join("+");
}

/**
 * Tooltip 展示用：未设置时返回 null（调用方据此省略快捷键段），
 * 区别于 formatShortcutForPlatform 的 "Not set" 占位（设置页表单用语义）。
 */
export function formatShortcutLabelOrNull(
  value: string | null | undefined,
  isMac: boolean = isMacPlatform(),
): string | null {
  return value ? formatShortcutForPlatform(value, isMac) : null;
}

export function splitShortcutForPlatform(
  value: string | null | undefined,
  isMac: boolean = isMacPlatform(),
): string[] | null {
  const parsed = parseShortcut(value);
  if (!parsed) {
    return null;
  }
  if (isMac) {
    const modifiers = MODIFIER_ORDER.flatMap((modifier) => {
      if (modifier === "cmd" && parsed.meta) {
        return MODIFIER_LABELS.cmd;
      }
      if (modifier === "ctrl" && parsed.ctrl) {
        return MODIFIER_LABELS.ctrl;
      }
      if (modifier === "alt" && parsed.alt) {
        return MODIFIER_LABELS.alt;
      }
      if (modifier === "shift" && parsed.shift) {
        return MODIFIER_LABELS.shift;
      }
      return [];
    });
    return [...modifiers, formatShortcutKeyLabel(parsed.key, KEY_LABELS)];
  }
  const modifiers: string[] = [];
  if (parsed.meta && parsed.ctrl) {
    modifiers.push("Meta");
  } else if (parsed.meta) {
    modifiers.push(MODIFIER_TEXT_LABELS.ctrl);
  }
  if (parsed.ctrl) {
    modifiers.push(MODIFIER_TEXT_LABELS.ctrl);
  }
  if (parsed.alt) {
    modifiers.push(MODIFIER_TEXT_LABELS.alt);
  }
  if (parsed.shift) {
    modifiers.push(MODIFIER_TEXT_LABELS.shift);
  }
  return [...modifiers, formatShortcutKeyLabel(parsed.key, TEXT_KEY_LABELS)];
}

/**
 * 录制用：把 keydown 事件转成快捷键字符串。要求主修饰键（cmd/ctrl/alt），
 * 唯一例外是 shift+tab（允许录入）。无法构成快捷键时返回 null。
 */
export function buildShortcutValue(event: KeyboardEvent): string | null {
  const key = normalizeKey(event.key);
  if (!key) {
    return null;
  }
  const hasPrimaryModifier = event.metaKey || event.ctrlKey || event.altKey;
  const allowShiftOnly = event.shiftKey && key === "tab";
  if (!hasPrimaryModifier && !allowShiftOnly) {
    return null;
  }
  const modifiers = [];
  if (event.metaKey) {
    modifiers.push("cmd");
  }
  if (event.ctrlKey) {
    modifiers.push("ctrl");
  }
  if (event.altKey) {
    modifiers.push("alt");
  }
  if (event.shiftKey) {
    modifiers.push("shift");
  }
  return [...modifiers, key].join("+");
}

export function matchesShortcutForPlatform(
  event: KeyboardEvent,
  value: string | null | undefined,
  isMac: boolean = isMacPlatform(),
): boolean {
  const parsed = parseShortcut(value);
  if (!parsed) {
    return false;
  }
  const key = normalizeKey(event.key);
  if (!key || key !== parsed.key) {
    return false;
  }
  if (isMac) {
    return (
      parsed.meta === event.metaKey &&
      parsed.ctrl === event.ctrlKey &&
      parsed.alt === event.altKey &&
      matchesShiftModifier(event, parsed)
    );
  }
  const wantsPrimary = parsed.meta || parsed.ctrl;
  const wantsMeta = parsed.meta && parsed.ctrl;
  return (
    wantsPrimary === event.ctrlKey &&
    wantsMeta === event.metaKey &&
    parsed.alt === event.altKey &&
    matchesShiftModifier(event, parsed)
  );
}

export function isEditableShortcutTarget(
  target: EventTarget | Element | null | undefined,
): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
    ),
  );
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function getDefaultInterruptShortcut(): string {
  return isMacPlatform() ? "ctrl+c" : "ctrl+shift+c";
}
