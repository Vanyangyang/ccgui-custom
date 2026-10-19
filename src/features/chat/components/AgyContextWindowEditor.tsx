import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/base/input/input";
import { Button } from "@/components/base/buttons/button";
import {
  AGY_REFERENCE_WINDOW_MAX,
  AGY_REFERENCE_WINDOW_MIN,
} from "./agy-context";

export function AgyContextWindowEditor({
  window,
  reportedWindow,
  onSave,
}: {
  window?: number;
  reportedWindow?: number;
  onSave: (tokens?: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(window == null ? "" : String(window / 1000));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!dirty) {
      setText(window == null ? "" : String(window / 1000));
    }
  }, [window, dirty]);

  async function save(reset: boolean) {
    if (inFlight.current) return;
    const trimmed = text.trim();
    const clear = reset || !trimmed;
    const tokens = clear ? undefined : Number(trimmed) * 1000;
    if (
      tokens !== undefined &&
      (!Number.isInteger(tokens) ||
        tokens < AGY_REFERENCE_WINDOW_MIN ||
        tokens > AGY_REFERENCE_WINDOW_MAX)
    ) {
      setFailed(true);
      setMessage(t("chat.agyReferenceWindowRangeError"));
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setMessage("");
    try {
      await onSave(tokens);
      if (mounted.current) {
        if (clear) setText("");
        setDirty(false);
        setFailed(false);
        setMessage(
          t(clear ? "chat.agyReferenceWindowResetDone" : "chat.agyReferenceWindowSaveDone"),
        );
      }
    } catch {
      if (mounted.current) {
        setFailed(true);
        setMessage(t("chat.agyReferenceWindowSaveFailed"));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 pb-3">
      <div className="flex flex-wrap items-end justify-end gap-2">
        <Input
          className="min-w-0 basis-full"
          size="small"
          label={t("chat.agyReferenceWindowSize")}
          value={text}
          placeholder={
            reportedWindow !== undefined && reportedWindow > 0
              ? String(reportedWindow / 1000)
              : t("chat.agyReferenceWindowDefault")
          }
          inputMode="decimal"
          isDisabled={saving}
          onChange={(value) => {
            setText(value);
            setDirty(true);
            setMessage("");
          }}
        />
        <Button
          size="small"
          disabled={saving}
          onClick={() => {
            void save(false);
          }}
        >
          {t(saving ? "chat.contextWindowSaving" : "chat.contextWindowSave")}
        </Button>
        <Button
          size="small"
          variant="secondary"
          disabled={saving}
          onClick={() => {
            void save(true);
          }}
        >
          {t("chat.contextWindowReset")}
        </Button>
      </div>
      <p className="text-caption-1-regular text-text-tertiary">
        {t("chat.agyReferenceWindowScope")}
      </p>
      {message && (
        <p role={failed ? "alert" : "status"} className="text-caption-1-regular text-text-secondary">
          {message}
        </p>
      )}
    </div>
  );
}
