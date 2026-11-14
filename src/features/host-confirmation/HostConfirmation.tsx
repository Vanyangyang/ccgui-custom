import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "react-aria-components";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { Button } from "@/components/base/buttons/button";
import { Collapsible } from "@/components/application/collapsible/collapsible";
import type { ConfirmationContent } from "./types";

function Section({ section }: { section: ConfirmationContent["sections"][number] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="min-w-0 rounded-xl border border-border-component-detail-container">
    <Button variant="secondary" className="w-full !justify-start border-0 bg-transparent shadow-none hover:bg-background-secondary-hover [&>span]:min-w-0 [&>span]:shrink [&>span]:gap-2" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <ChevronRight aria-hidden="true" className={`size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
      <span className="min-w-0 whitespace-normal break-words text-left">{section.title}</span>
    </Button>
    <Collapsible open={open} seconds={0.2} className="motion-reduce:!transition-none">
      <div id={id} aria-hidden={!open} className="host-confirmation-prose min-w-0 select-text p-4 pt-2 text-body-regular text-text-primary [overflow-wrap:anywhere] [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:text-lg [&_h2]:text-base [&_h3]:font-semibold [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-background-secondary-default [&_pre]:p-3 [&_pre]:whitespace-pre-wrap [&_code]:font-mono [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border-table [&_td]:p-2 [&_th]:p-2">
        {section.markdown ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
          // Render links and image descriptions as inert selectable text. No remote
          // requests, navigation, raw HTML, chat renderers or plugin extensions.
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>{alt}</span>,
          input: () => null,
        }}>{section.body}</ReactMarkdown> : <p className="whitespace-pre-wrap">{section.body}</p>}
      </div>
    </Collapsible>
  </section>;
}

export function HostConfirmation({ content, respond, onReady }: {
  content: ConfirmationContent;
  respond: (accepted: boolean) => Promise<void>;
  onReady?: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const messageId = useId();
  const footer = useRef<HTMLElement>(null);
  const submitting = useRef(false);
  const affirmativeAttempted = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    mounted.current = true;
    footer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    onReady?.();
    return () => { mounted.current = false; };
  }, [onReady]);
  const submit = async (accepted: boolean) => {
    if (submitting.current || (accepted && affirmativeAttempted.current)) return;
    submitting.current = true;
    if (accepted) affirmativeAttempted.current = true;
    setBusy(true);
    try {
      await respond(accepted);
      // Remain locked until the native window closes, including late clicks.
    } catch {
      submitting.current = false;
      if (mounted.current) { setBusy(false); setFailed(true); }
    }
  };
  return <div data-host-confirmation-root onKeyDownCapture={event => {
    if (event.key === "Escape") { event.preventDefault(); void submit(false); }
  }}><Dialog aria-labelledby={titleId} aria-describedby={messageId} className="flex h-dvh min-w-0 flex-col overflow-hidden bg-background-primary-default text-text-primary outline-none">
    <header className="shrink-0 border-b border-border-component-detail-container px-5 py-4">
      <h1 id={titleId} className="text-lg font-semibold [overflow-wrap:anywhere]">{content.title}</h1>
    </header>
    <main className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-5">
      <p id={messageId} className="whitespace-pre-wrap text-body-regular text-text-secondary [overflow-wrap:anywhere]">{content.message}</p>
      <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2 text-body-regular">
        {content.fields.map((field, index) => <div key={index} className="contents"><dt className="text-text-secondary [overflow-wrap:anywhere]">{field.label}</dt><dd className="min-w-0 select-text whitespace-pre-wrap [overflow-wrap:anywhere]">{field.value}</dd></div>)}
      </dl>
      {content.sections.map((section, index) => <Section key={index} section={section} />)}
    </main>
    <footer ref={footer} className="shrink-0 border-t border-border-component-detail-container px-5 py-4">
      {failed && <p role="alert" className="mb-3 text-body-regular text-text-secondary">{t("hostConfirmation.submitError")}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => void submit(false)}>{content.dismissLabel}</Button>
        <Button variant="primary" disabled={busy || failed} onClick={() => void submit(true)}>{content.confirmLabel}</Button>
      </div>
    </footer>
  </Dialog></div>;
}
