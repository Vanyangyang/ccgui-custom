import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import { Button } from "@/components/base/buttons/button";
import { cx } from "@/utils/cx";
import { sendMissionMessage } from "../ai-orchestrator";
import { usesOnlySimulatedCapabilities } from "../engine/validator";
import { useMissionStore } from "../store";
import { keyedLines } from "./keyed-lines";

/**
 * 编排对话区：用户描述目标/提出修改，AI 生成结构化提案；变更摘要在
 * 对话里逐条展示。生成中禁止重复发送；失败原文只作为纯文本保留。
 */
export function ConversationPane() {
  const { t } = useTranslation();
  const { flow, generating } = useMissionStore(
    useShallow((s) => {
      const flow = s.flows.find((item) => item.id === s.selectedFlowId) ?? null;
      return {
        flow,
        generating: flow ? s.generatingByFlow[flow.id] === true : false,
      };
    }),
  );
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [flow?.messages.length, generating]);

  const submit = useCallback(
    (text?: string) => {
      const value = (text ?? input).trim();
      if (!value || !flow || generating) return;
      setInput("");
      void sendMissionMessage(flow.id, value);
    },
    [flow, generating, input],
  );

  if (!flow) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-body-2-regular text-text-tertiary">
        {t("mission.conversationEmpty")}
      </div>
    );
  }

  const suggestions = flow.draft
    ? [
        t("mission.suggestionConcurrency"),
        t("mission.suggestionApprovalAll"),
        t("mission.suggestionRetry"),
      ]
    : [
        t("mission.suggestionPr"),
        t("mission.suggestionFeedback"),
        t("mission.suggestionReport"),
      ];

  return (
    <div className="flex h-full min-h-0 w-[320px] shrink-0 flex-col border-r border-separator-border bg-background-primary-default max-lg:w-[280px]">
      <div className="flex items-center gap-2 border-b border-separator-border px-4 py-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-status-blue-background/40 text-status-blue-text">
          <Sparkles className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-body-2-medium text-text-primary">
            {t("mission.assistantName")}
          </div>
          <div className="truncate text-caption-1-regular text-text-tertiary">
            {t("mission.assistantHint")}
          </div>
        </div>
        {flow.draft && usesOnlySimulatedCapabilities(flow.draft) && (
          <span className="ml-auto shrink-0 rounded-sm border border-border-button-default px-1.5 py-0.5 text-caption-1-medium text-text-tertiary">
            {t("mission.demoTag")}
          </span>
        )}
      </div>

      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label={t("mission.conversationLabel")}
        className="min-h-0 flex-1 overflow-auto px-4 py-4"
      >
        {flow.messages.length === 0 && (
          <p className="text-body-2-regular leading-relaxed text-text-tertiary">
            {t("mission.conversationEmpty")}
          </p>
        )}
        {flow.messages.map((message) => (
          <article key={message.id} className="mb-5">
            <div className="mb-1.5 text-caption-1-medium text-text-tertiary">
              {message.role === "user" ? t("mission.roleYou") : t("mission.roleAssistant")}
            </div>
            {message.text && (
              <div
                className={cx(
                  "whitespace-pre-wrap break-words text-body-2-regular leading-relaxed",
                  message.role === "user"
                    ? "rounded-lg rounded-br-sm border border-separator-border bg-background-secondary-default px-3 py-2 text-text-secondary"
                    : "text-text-primary",
                )}
              >
                {message.text}
              </div>
            )}
            {message.change && (
              <div className="mt-2 rounded-md border border-status-blue-text/30 bg-status-blue-background/20 px-3 py-2">
                <div className="text-caption-1-medium text-status-blue-text">
                  {t("mission.changeCardTitle", { version: message.change.version })}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {keyedLines(message.change.lines).map(({ key, text }) => (
                    <li key={key} className="text-caption-1-regular leading-relaxed text-text-secondary">
                      {text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {message.error && (
              <p className="mt-2 whitespace-pre-wrap break-words text-caption-1-regular leading-relaxed text-status-rose-text">
                {message.error}
              </p>
            )}
          </article>
        ))}
        {generating && (
          <div className="text-caption-1-regular text-text-tertiary">
            {t("mission.chatGenerating")}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-separator-border p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => submit(suggestion)}
              className="cursor-pointer rounded-md border border-separator-border bg-background-primary-default px-2 py-1 text-caption-1-regular text-text-secondary transition-colors hover:bg-background-secondary-hover"
            >
              {suggestion}
            </button>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="rounded-lg border border-border-button-default bg-background-primary-default p-2 shadow-xs transition-colors focus-within:border-status-blue-text/60">
            <label htmlFor="mission-chat-input" className="sr-only">
              {t("mission.composerLabel")}
            </label>
            <textarea
              id="mission-chat-input"
              value={input}
              maxLength={1600}
              rows={3}
              disabled={generating}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={t("mission.composerPlaceholder")}
              className="w-full resize-y bg-transparent text-body-2-regular text-text-primary outline-none placeholder:text-text-placeholder disabled:opacity-60"
            />
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-caption-1-regular text-text-tertiary">
                {t("mission.chatHint")}
              </span>
              <Button
                type="submit"
                size="small"
                iconOnly
                leadingIcon={ArrowUp}
                aria-label={t("mission.send")}
                disabled={generating || input.trim() === ""}
              />
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
