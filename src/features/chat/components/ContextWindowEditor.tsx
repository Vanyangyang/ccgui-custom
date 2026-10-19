import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/base/input/input";
import { Button } from "@/components/base/buttons/button";
import type { ContextWindowEditBlock } from "../claude-context-window";

export function ContextWindowEditor({ window, modelWindow, block, onSave }: {
  window?: number;
  modelWindow: number;
  block?: ContextWindowEditBlock;
  onSave: (tokens?: number) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(String((window ?? modelWindow) / 1000));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!dirty) setText(String((window ?? modelWindow) / 1000));
  }, [window, modelWindow, dirty]);

  async function save(reset: boolean) {
    if (block || inFlight.current) return;
    const tokens = reset ? undefined : Number(text) * 1000;
    if (tokens !== undefined && (!Number.isInteger(tokens) || tokens < 100_000 || tokens > 1_000_000)) {
      setFailed(true);
      setMessage(t("chat.contextWindowRangeError"));
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setMessage("");
    try {
      await onSave(tokens);
      if (mounted.current) {
        setDirty(false);
        setFailed(false);
        setMessage(t(reset ? "chat.contextWindowResetDone" : "chat.contextWindowSaveDone"));
      }
    } catch {
      if (mounted.current) {
        setFailed(true);
        setMessage(t("chat.contextWindowSaveFailed"));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return <div className="flex flex-col gap-2 px-4 pb-3">
    <div className="flex items-end gap-2">
      <Input size="small" label={t("chat.contextWindowSize")} value={text}
        inputMode="decimal" isDisabled={Boolean(block) || saving}
        onChange={(value) => { setText(value); setDirty(true); setMessage(""); }} />
      <Button size="small" disabled={Boolean(block) || saving} onClick={() => { void save(false); }}>
        {t(saving ? "chat.contextWindowSaving" : "chat.contextWindowSave")}
      </Button>
      <Button size="small" variant="secondary" disabled={Boolean(block) || saving} onClick={() => { void save(true); }}>
        {t("chat.contextWindowReset")}
      </Button>
    </div>
    <p className="text-caption-1-regular text-text-tertiary">
      {t(block ? `chat.contextWindowBlock_${block}` : "chat.contextWindowScope")}
    </p>
    {message && <p role={failed ? "alert" : "status"} className="text-caption-1-regular text-text-secondary">{message}</p>}
  </div>;
}
