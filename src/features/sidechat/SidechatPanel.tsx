import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ArrowUpRight from "lucide-react/dist/esm/icons/arrow-up-right";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Check from "lucide-react/dist/esm/icons/check";
import Copy from "lucide-react/dist/esm/icons/copy";
import CornerDownLeft from "lucide-react/dist/esm/icons/corner-down-left";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import X from "lucide-react/dist/esm/icons/x";
import { Button } from "@/components/base/buttons/button";
import { useCopied } from "@/hooks/use-copied";
import type { Message } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { useChatStore, type ActiveSession } from "@/features/chat/store";
import { resolveSideLaunch } from "./launch";
import { CacheHitBadge, SideMarkdown, SideThinking, SideToolPills } from "./side-parts";
import { isSidechatSupportedEngine, useSidechatStore, type SideToolItem } from "./store";
import { insertSideAnswer } from "./insert-answer";
import { useSidechatResize } from "./use-sidechat-resize";
import { SidechatComposer } from "./SidechatComposer";
import { MessageImages } from "@/features/chat/components/MessageImages";
import { SideRunStatus } from "./SideRunStatus";

function SideReplyActions({ text, sessionKey }: { text: string; sessionKey: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopied();
  return <div className="mt-1 flex flex-wrap gap-1">
    <Button variant="ghost" size="xs" leadingIcon={copied ? Check : Copy} onClick={() => copy(text)}>
      {copied ? t("common.copied") : t("sidechat.copyAnswer")}
    </Button>
    <Button variant="ghost" size="xs" leadingIcon={CornerDownLeft} onClick={() => insertSideAnswer(sessionKey, text)}>
      {t("sidechat.insertAnswer")}
    </Button>
  </div>;
}

/** Consecutive tool rows collapse into one pill strip. */
type Block =
  | { kind: "user"; key: number; text: string; images?: string[] }
  | { kind: "thinking"; key: number; text: string; live: boolean }
  | { kind: "assistant"; key: number; text: string; live: boolean }
  | { kind: "tools"; key: number; tools: SideToolItem[] };

function toBlocks(messages: Message[]): Block[] {
  const blocks: Block[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      blocks.push({ kind: "user", key: m.seq, text: m.text, images: m.images });
    } else if (m.role === "thinking") {
      blocks.push({ kind: "thinking", key: m.seq, text: m.text, live: m.live === true });
    } else if (m.role === "assistant") {
      blocks.push({ kind: "assistant", key: m.seq, text: m.text, live: m.live === true });
    } else if (m.role === "tool") {
      const item: SideToolItem = {
        id: String(m.seq),
        name: m.text,
        path: m.path ?? null,
        status: m.live ? "running" : "done",
      };
      const last = blocks[blocks.length - 1];
      if (last?.kind === "tools") last.tools.push(item);
      else blocks.push({ kind: "tools", key: m.seq, tools: [item] });
    }
  }
  return blocks;
}

/**
 * `/sidechat` branch conversation, docked beside the main chat. It is a
 * separate fork of the parent session, with best-effort prompt-cache reuse. It
 * runs while the main conversation streams, and never writes into the main
 * transcript. Closing keeps the fork; resetting re-forks from the latest
 * parent state; promoting turns it into a regular tab.
 */
export const SidechatPanel = memo(function SidechatPanel({
  active,
  sessionKey: key,
}: {
  active: ActiveSession | null;
  sessionKey: string;
}) {
  const { t } = useTranslation();
  const sc = useSidechatStore((s) => (key ? s.sidechatBySession[key] : undefined));
  const closeSidechat = useSidechatStore((s) => s.closeSidechat);
  const resetSidechat = useSidechatStore((s) => s.resetSidechat);
  const promoteSidechatToTab = useSidechatStore((s) => s.promoteSidechatToTab);
  const [promoting, setPromoting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const visible = Boolean(sc?.open && isSidechatSupportedEngine(sc.engine));
  const { panelRef, handleRef } = useSidechatResize(visible, key);

  const messages = sc?.messages;
  const blocks = useMemo(() => toBlocks(messages ?? []), [messages]);

  // Follow the stream only while the user is parked at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const send = useCallback(
    (raw: string, images: string[]) => {
      const prompt = raw.trim();
      if ((!prompt && images.length === 0) || !key) return;
      const launch = resolveSideLaunch(active);
      if (!launch) return;
      stickRef.current = true;
      void useSidechatStore.getState().sendSidechatMessage({
        sessionKey: key,
        engine: launch.engine,
        workspacePath: launch.workspacePath,
        parentSessionId: launch.parentSessionId,
        prompt,
        images,
        parentMessages: launch.parentMessages,
        model: launch.model,
        effort: launch.effort,
        providerId: launch.providerId,
        parentPermission: launch.parentPermission,
      });
    },
    [active, key],
  );

  const promote = useCallback(async () => {
    if (promoting) return;
    setPromoting(true);
    try {
      const promoted = await promoteSidechatToTab(key);
      if (!promoted) return;
      const chat = useChatStore.getState();
      await chat.refreshSessions();
      await chat.selectSession(promoted.engine, promoted.sessionId, promoted.workspacePath);
    } catch (error) {
      useChatStore.setState({ actionError: errorText(error) });
    } finally {
      setPromoting(false);
    }
  }, [key, promoteSidechatToTab, promoting]);

  if (!sc || !sc.open || !isSidechatSupportedEngine(sc.engine)) return null;

  const canPromote = Boolean(sc.sideSessionId) && !sc.streaming && !promoting;
  const promoteHint = promoting
    ? "sidechat.promoting"
    : sc.streaming
      ? "sidechat.promoteBusyHint"
      : !sc.sideSessionId
        ? "sidechat.promoteUnavailableHint"
        : "sidechat.promoteHint";
  const canReset = sc.messages.length > 0 || Boolean(sc.sideSessionId);

  return (
    <aside
      ref={panelRef}
      aria-label={t("sidechat.sidechatTitle")}
      className="relative flex h-full min-h-0 min-w-0 w-full shrink-0 flex-col border-l border-border-button-default bg-background-primary-default md:w-[var(--sidechat-width,26rem)] max-md:h-1/2 max-md:border-l-0 max-md:border-t"
    >
      <div
        ref={handleRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("sidechat.resize")}
        title={t("sidechat.resize")}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize touch-none select-none outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 hover:before:bg-border-focus-ring focus-visible:before:bg-border-focus-ring md:block"
      />
      <header className="flex shrink-0 items-center gap-2 border-b border-border-button-default px-3 py-2">
        <GitBranch aria-hidden className="size-4 shrink-0 text-text-secondary" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body-medium text-text-primary">
            {t("sidechat.sidechatTitle")}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-caption-1-medium text-text-tertiary">
            <CacheHitBadge cacheRead={sc.usage?.cacheRead} />
          </span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          leadingIcon={RotateCcw}
          aria-label={t("sidechat.reset")}
          title={t("sidechat.resetHint")}
          disabled={!canReset}
          onClick={() => void resetSidechat(key)}
        />
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          leadingIcon={ArrowUpRight}
          aria-label={t("sidechat.promote")}
          title={t(promoteHint)}
          aria-busy={promoting}
          disabled={!canPromote}
          onClick={() => void promote()}
        />
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          leadingIcon={X}
          aria-label={t("sidechat.close")}
          title={t("sidechat.closeHint")}
          onClick={() => closeSidechat(key)}
        />
      </header>

      <div className="flex shrink-0 flex-col gap-1 border-b border-border-button-default px-3 py-2">
        <div
          role="group"
          aria-label={t("sidechat.modeLabel")}
          className="inline-flex w-fit flex-wrap items-center gap-0.5 rounded-md border border-border-button-default bg-background-secondary-default p-0.5"
        >
          {(["read-only", "execute"] as const).map((mode) => {
            const selected = (sc.mode ?? "read-only") === mode;
            return (
              <Button
                key={mode}
                variant={selected ? "primary" : "secondary"}
                size="xs"
                aria-pressed={selected}
                disabled={sc.streaming}
                className={
                  selected
                    ? undefined
                    : "border-transparent bg-transparent text-text-tertiary shadow-none hover:border-transparent hover:bg-background-primary-hover hover:text-text-primary"
                }
                title={t(sc.streaming ? "sidechat.modeBusyHint" : mode === "execute" ? "sidechat.executeHint" : "sidechat.readOnlyHint")}
                onClick={() => useSidechatStore.getState().setSidechatMode(key, mode)}
              >
                {t(mode === "execute" ? "sidechat.execute" : "sidechat.readOnly")}
              </Button>
            );
          })}
        </div>
        <p className="text-caption-1-regular text-text-tertiary">
          {t(sc.streaming ? "sidechat.modeBusyHint" : sc.mode === "execute" ? "sidechat.executeHint" : "sidechat.readOnlyHint")}
        </p>
      </div>

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-busy={sc.streaming}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-3"
      >
        {blocks.length === 0 ? (
          <p className="my-auto px-2 text-center text-body-regular text-text-tertiary">
            {t("sidechat.emptyHint")}
          </p>
        ) : (
          blocks.map((b) => {
            switch (b.kind) {
              case "user":
                return (
                  <div
                    key={b.key}
                    className="max-w-[90%] self-end whitespace-pre-wrap break-words rounded-xl bg-background-tertiary-default px-3 py-2 text-body-regular text-text-primary"
                  >
                    {b.images && b.images.length > 0 && <MessageImages images={b.images} />}
                    {b.text}
                  </div>
                );
              case "thinking":
                return <SideThinking key={b.key} text={b.text} streaming={b.live} />;
              case "tools":
                return <SideToolPills key={b.key} tools={b.tools} />;
              default:
                return b.text.trim() ? (
                  <div key={b.key} className="min-w-0">
                    <SideMarkdown text={b.text} workspacePath={sc.workspacePath} streaming={b.live} />
                    {!b.live && <SideReplyActions text={b.text} sessionKey={key} />}
                  </div>
                ) : null;
            }
          })
        )}
        {sc.streaming && <SideRunStatus key={sc.runId} startedAt={sc.startedAt} progress={sc.progress} />}
        {sc.error && (
          <div
            role="alert"
            className="whitespace-pre-wrap break-words rounded-lg border border-border-error-default bg-background-tertiary-error px-3 py-2 text-body-regular text-text-error-primary"
          >
            {sc.error}
          </div>
        )}
      </div>

      <SidechatComposer key={key} sessionKey={key} state={sc} onSend={send} />
    </aside>
  );
});
