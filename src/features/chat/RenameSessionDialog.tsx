import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import WandSparkles from "lucide-react/dist/esm/icons/wand-sparkles";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { ModalShell } from "@/components/dialogs";
import { errorText } from "@/lib/errors";
import { ipc, type SessionMeta, type SuggestTitleErrorCode } from "@/lib/ipc";

const SUGGEST_ERROR_CODES: readonly string[] = [
  "engine_disabled",
  "not_found",
  "no_content",
  "timeout",
  "invalid_output",
  "failed",
] satisfies SuggestTitleErrorCode[];

/** Map a `suggest_session_title` rejection to its code; anything the host
 *  did not spell as a known code reads as "failed". */
export function suggestTitleErrorCode(err: unknown): SuggestTitleErrorCode {
  const text = errorText(err).trim();
  return SUGGEST_ERROR_CODES.includes(text) ? (text as SuggestTitleErrorCode) : "failed";
}

/**
 * What confirming `value` asks of the host: the title to save, `""` to clear
 * the manual title, or null when there is nothing to write. Confirming the
 * prefilled text unchanged must not save it — that would turn the auto (or
 * first-message) title into a manual one and lock auto-naming for good.
 */
export function renameIntent(
  session: Pick<SessionMeta, "title" | "customTitle">,
  value: string,
): string | null {
  const next = value.trim();
  if (!next) return session.customTitle ? "" : null;
  return next === (session.customTitle || session.title).trim() ? null : next;
}

type Note =
  | { kind: "filled" }
  | { kind: "fits" }
  | { kind: "error"; code: SuggestTitleErrorCode };

/** Session rename: prefilled with the displayed title, leaving it empty hands
 *  the session back to auto-naming, and 生成标题 asks the host for a
 *  suggestion the user still has to confirm (saving it makes it manual). */
export function RenameSessionDialog({
  session,
  onRename,
  onClose,
}: {
  session: SessionMeta;
  /** Called only for a real change; `""` clears the manual title. */
  onRename: (title: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(session.customTitle || session.title);
  const [generating, setGenerating] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [selectTick, setSelectTick] = useState(0);
  // Reached through the field shell: on React 18 a `ref` prop on the base
  // Input is dropped before it gets there, `groupRef` is not.
  const fieldRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  // A suggestion belongs to the draft it started from. Even an edit followed
  // by undo invalidates it, so late results cannot replace the user's work.
  const editRevision = useRef(0);
  // The dialog unmounts on close; a suggestion landing after that is dropped.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The field takes the initial focus, selected so a rename can be typed over
  // directly; a filled-in suggestion is selected the same way.
  useEffect(() => {
    const field = fieldRef.current?.querySelector("input");
    field?.focus();
    field?.select();
  }, [selectTick]);

  const generate = async () => {
    if (inFlight.current) return;
    const requestedRevision = editRevision.current;
    inFlight.current = true;
    setGenerating(true);
    setNote(null);
    try {
      const result = await ipc.suggestSessionTitle(session.engine, session.sessionId);
      if (!alive.current || editRevision.current !== requestedRevision) return;
      const title = result.title.trim();
      if (!result.changed) {
        setNote({ kind: "fits" });
      } else if (title) {
        setValue(title);
        setNote({ kind: "filled" });
        setSelectTick((n) => n + 1);
      } else {
        setNote({ kind: "error", code: "invalid_output" });
      }
    } catch (err) {
      if (alive.current && editRevision.current === requestedRevision) {
        setNote({ kind: "error", code: suggestTitleErrorCode(err) });
      }
    } finally {
      inFlight.current = false;
      if (alive.current) setGenerating(false);
    }
  };

  const status =
    note?.kind === "filled"
      ? t("chat.titleSuggestionFilled")
      : note?.kind === "fits"
        ? t("chat.titleAlreadyFits")
        : null;

  return (
    <ModalShell onClose={onClose} label={t("chat.renameSession")} className="w-96">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const title = renameIntent(session, value);
          onClose();
          if (title !== null) onRename(title);
        }}
        className="flex flex-col gap-3"
      >
        <Input
          groupRef={fieldRef}
          label={t("chat.renameSession")}
          hint={t("chat.renameSessionHint")}
          value={value}
          onChange={(next) => {
            editRevision.current += 1;
            setValue(next);
            setNote(null);
          }}
          size="small"
        />
        <div role="status" className="text-caption-1-regular text-text-secondary empty:hidden">
          {status}
        </div>
        {note?.kind === "error" && (
          <p role="alert" className="text-caption-1-regular text-text-error-primary">
            {t(`chat.suggestTitleError.${note.code}`)}
          </p>
        )}
        <div className="flex items-center gap-2">
          {/* Remote (plugin-fed) sessions have no local transcript for the
              host to read, so there is nothing to suggest from. */}
          {!session.remote && (
            <Button
              variant="ghost"
              size="small"
              disabled={generating}
              aria-busy={generating}
              onClick={() => void generate()}
            >
              <span className="flex items-center gap-1.5">
                {generating ? (
                  <Loader2
                    aria-hidden
                    className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  <WandSparkles aria-hidden className="size-3.5 shrink-0" />
                )}
                {t("chat.generateTitle")}
              </span>
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" size="small" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" size="small">
              {t("common.confirm")}
            </Button>
          </div>
        </div>
      </form>
    </ModalShell>
  );
}
