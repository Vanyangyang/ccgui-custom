import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Square from "lucide-react/dist/esm/icons/square";
import { Button } from "@/components/base/buttons/button";
import { TextArea } from "@/components/base/input/textarea";
import { useChatStore } from "@/features/chat/store";
import { ErrorBanner } from "@/features/chat/components/ErrorBanner";
import { useComposerImages } from "@/features/chat/components/use-composer-images";
import { useSidechatStore, type SidechatState } from "./store";

const EMPTY_IMAGES: string[] = [];

export function SidechatComposer({ sessionKey, state, onSend }: {
  sessionKey: string;
  state: SidechatState;
  onSend: (text: string, images: string[]) => void;
}) {
  const { t } = useTranslation();
  const supportsImages = useChatStore((s) => s.engines.find((engine) => engine.id === state.engine)?.supportsImages ?? false);
  const [unsupported, setUnsupported] = useState(false);
  const draft = useMemo(() => ({
    paths: state.draftImages ?? EMPTY_IMAGES,
    getPaths: () => useSidechatStore.getState().sidechatBySession[sessionKey]?.draftImages ?? EMPTY_IMAGES,
    update: (updater: (paths: string[]) => string[]) => useSidechatStore.getState().updateSidechatImages(sessionKey, updater),
  }), [sessionKey, state.draftImages]);
  const { images, previews, imageError, importingImages, removeImage, pasteImages, dismissImageError } = useComposerImages(`sidechat:${sessionKey}`, draft);
  const canSend = (state.draft.trim().length > 0 || images.length > 0) && !importingImages;
  const send = () => {
    if (!canSend) return;
    if (images.length > 0 && !supportsImages) { setUnsupported(true); return; }
    onSend(state.draft, images);
  };

  return <footer className="flex shrink-0 flex-col gap-1.5 border-t border-border-button-default px-3 py-2"
    onPasteCapture={(event) => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      const files = Array.from(event.clipboardData.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile()).filter((file): file is File => file !== null);
      if (!files.length) return;
      event.preventDefault();
      if (!supportsImages) { setUnsupported(true); return; }
      setUnsupported(false);
      pasteImages(files);
    }}>
    <ErrorBanner message={unsupported ? t("chat.imagesUnsupported") : imageError} onDismiss={() => { setUnsupported(false); dismissImageError(); }} />
    {importingImages && <span role="status" className="text-caption-1-medium text-text-tertiary">{t("common.loading")}</span>}
    {images.length > 0 && <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto" aria-label={t("chat.addFilesFolders")}>
      {images.map((path) => {
        const preview = previews[path];
        const name = preview?.name ?? path.split(/[\\/]/).pop() ?? path;
        return <span key={path} className="inline-flex max-w-full items-center gap-1 rounded-lg bg-background-tertiary-default p-1 text-caption-1-medium text-text-secondary">
          {preview && <img src={preview.url} alt={name} className="size-12 shrink-0 rounded object-cover" />}
          <span className="max-w-32 truncate">{name}</span>
          <button type="button" aria-label={`${t("common.close")} ${name}`} className="px-1 hover:text-text-primary" onClick={() => removeImage(path)}>×</button>
        </span>;
      })}
    </div>}
    <TextArea aria-label={t("sidechat.inputLabel")} placeholder={t("sidechat.placeholder")} rows={2}
      value={state.draft} onChange={(value) => useSidechatStore.getState().setSidechatDraft(sessionKey, value)}
      fieldClassName="max-h-40" inputClassName="resize-none"
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        send();
      }} />
    <div className="flex items-center justify-end gap-1">
      {state.streaming && <Button variant="secondary" size="xs" leadingIcon={Square} onClick={() => void useSidechatStore.getState().stopSidechat(sessionKey)}>{t("sidechat.stop")}</Button>}
      <Button variant="primary" size="xs" disabled={!canSend} onClick={send}>{t("sidechat.send")}</Button>
    </div>
  </footer>;
}
