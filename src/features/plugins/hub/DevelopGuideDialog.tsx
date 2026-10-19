import { useTranslation } from "react-i18next";
import SquareArrowOutUpRight from "lucide-react/dist/esm/icons/square-arrow-out-up-right";
import X from "lucide-react/dist/esm/icons/x";
import { ModalShell } from "@/components/dialogs";
import { openExternal } from "@/lib/platform";

/** Where plugins are submitted (central index) and a real reference plugin
 *  to learn from — both repos actually exist; the template repo is still
 *  local-only, so the tutorial points at the example instead of a dead link. */
const SUBMIT_REPO_URL = "https://github.com/zhukunpenglinyutong/ccgui-plugins";
const EXAMPLE_PLUGIN_URL =
  "https://github.com/zhukunpenglinyutong/ccgui-plugin-react-doctor";

function LinkButton({ url, label }: { url: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => openExternal(url)}
      className="flex cursor-pointer items-center gap-1 text-body-medium text-text-brand-secondary hover:underline"
    >
      {label}
      <SquareArrowOutUpRight className="size-3.5" aria-hidden />
    </button>
  );
}

/** Authoring + submission tutorial (用户教育): how to get a plugin built
 *  (AI chat or by hand) and how to get it into the market. Plain ordered
 *  steps — the full guide lives in the template repo README, linked through
 *  the example repo. */
export function DevelopGuideDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const aiSteps = t("plugins.market.aiSteps", { returnObjects: true }) as string[];
  const localSteps = t("plugins.market.localSteps", { returnObjects: true }) as string[];
  const submitSteps = t("plugins.market.submitSteps", { returnObjects: true }) as string[];
  return (
    <ModalShell
      onClose={onClose}
      label={t("plugins.market.developTitle")}
      className="flex max-h-[calc(100dvh-64px)] w-[560px] max-w-[calc(100vw-32px)] flex-col"
      dialogClassName="flex flex-col gap-4 overflow-y-auto"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-body-medium font-medium text-text-primary">
          {t("plugins.market.developTitle")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-foreground-icon-secondary transition-colors hover:bg-background-secondary-hover hover:text-foreground-icon-primary"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-body-medium text-text-primary">
          {t("plugins.market.aiTitle")}
        </span>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-body-medium text-text-secondary">
          {aiSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-body-medium text-text-primary">
          {t("plugins.market.localTitle")}
        </span>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-body-medium text-text-secondary">
          {localSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <LinkButton url={EXAMPLE_PLUGIN_URL} label={t("plugins.market.viewExample")} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-body-medium text-text-primary">
          {t("plugins.market.submitTitle")}
        </span>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-body-medium text-text-secondary">
          {submitSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-medium text-text-tertiary">
            {t("plugins.market.repoAddress")}
          </span>
          <code className="rounded-md bg-background-secondary-default px-1.5 py-0.5 text-xs text-text-secondary">
            github.com/zhukunpenglinyutong/ccgui-plugins
          </code>
          <LinkButton url={SUBMIT_REPO_URL} label={t("plugins.market.openSubmitRepo")} />
        </div>
      </div>
    </ModalShell>
  );
}
