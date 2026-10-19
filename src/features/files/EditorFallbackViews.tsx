import { useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/base/empty-state";
import { ImageLightbox } from "@/components/base/image-lightbox";
import { dataUrlBytes, imageMetaText } from "@/utils/image-meta";

function EditorHeader({ name, meta }: { name: string; meta?: string }) {
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border-button-default px-3">
      <span className="truncate text-body-medium text-text-primary">{name}</span>
      {meta && (
        <span className="ml-3 shrink-0 whitespace-nowrap text-caption-1-medium text-text-tertiary">
          {meta}
        </span>
      )}
    </div>
  );
}

export function ImageFileView({ name, dataUrl }: { name: string; dataUrl: string | null }) {
  const { t } = useTranslation();
  // Tagged with the URL so a stale decode never leaks into the next file
  // when the view switches without remounting.
  const [dims, setDims] = useState<{ url: string; width: number; height: number } | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const current = dims && dims.url === dataUrl ? dims : null;
  const meta = imageMetaText({
    width: current?.width,
    height: current?.height,
    size: dataUrl ? (dataUrlBytes(dataUrl) ?? undefined) : undefined,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorHeader name={name} meta={meta} />
      <EmptyState className="overflow-auto bg-background-secondary-default p-4">
        {dataUrl ? (
          <button
            type="button"
            onClick={() => setZoomOpen(true)}
            aria-label={name}
            title={t("chat.zoomIn")}
            className="cursor-zoom-in"
          >
            <img
              src={dataUrl}
              alt={name}
              onLoad={(e) =>
                setDims({
                  url: dataUrl,
                  width: e.currentTarget.naturalWidth,
                  height: e.currentTarget.naturalHeight,
                })
              }
              className="max-h-full max-w-full object-contain"
            />
          </button>
        ) : (
          <p className="text-body-medium text-text-tertiary">{t("files.imageTooLarge")}</p>
        )}
      </EmptyState>
      {zoomOpen && dataUrl && (
        <ImageLightbox src={dataUrl} name={name} onClose={() => setZoomOpen(false)} />
      )}
    </div>
  );
}

export function BinaryFileView({ name }: { name: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EditorHeader name={name} />
      <EmptyState className="p-6">
        <p className="text-body-medium text-text-tertiary">{t("files.binaryFile")}</p>
      </EmptyState>
    </div>
  );
}
