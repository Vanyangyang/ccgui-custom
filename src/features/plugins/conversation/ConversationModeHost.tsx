import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  conversationModeRegistry,
  pluginIdFromRegistryKey,
  useRegistry,
  type ConversationModeDef,
  type PluginConversationProps,
} from "@ccgui/plugin-sdk";
import { PluginBoundary } from "../boundary/PluginBoundary";
import { getConversationModeState } from "./state";

function ModeEntry({ mode, disabled, onSelect }: {
  mode: ConversationModeDef;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? t("plugins.conversationMode.busy") : mode.label()}
      onClick={() => onSelect(mode.id)}
      className="cursor-pointer rounded-md px-1.5 py-1 text-body-2-medium text-text-tertiary transition-colors duration-150 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {mode.label()}
    </button>
  );
}

export function ConversationModePicker({ disabled, onSelect }: {
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const modes = useRegistry(conversationModeRegistry);
  return <>{modes.map((mode) => (
    <PluginBoundary key={mode.id} pluginId={pluginIdFromRegistryKey(mode.id)}>
      <ModeEntry mode={mode} disabled={disabled} onSelect={onSelect} />
    </PluginBoundary>
  ))}</>;
}

export function ConversationModePane({ mode, ...props }: PluginConversationProps & { mode: ConversationModeDef }) {
  return <ConversationModeSession key={JSON.stringify([mode.id, props.conversationId])} mode={mode} {...props} />;
}

function ConversationModeSession({ mode, ...props }: PluginConversationProps & { mode: ConversationModeDef }) {
  const { t } = useTranslation();
  const [exitBlocked, updateExitBlocked] = useState(() => getConversationModeState().isExitBlocked(props.conversationId));
  const blocked = useRef(exitBlocked);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const setExitBlocked = useCallback((value: boolean) => {
    if (!mounted.current) return;
    blocked.current = value;
    getConversationModeState().setExitBlocked(props.conversationId, mode.id, value);
    updateExitBlocked(value);
  }, [props.conversationId, mode.id]);
  const onExit = useCallback(() => {
    if (mounted.current && !blocked.current) props.onExit();
  }, [props.onExit]);
  const Component = mode.component;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-conversation-mode={mode.id}>
      <div className="flex shrink-0 items-center border-b border-border-primary px-4 py-2">
        <button type="button" onClick={onExit} disabled={exitBlocked} className="cursor-pointer rounded-md px-2 py-1 text-body-2-medium text-text-tertiary transition-colors duration-150 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50">
          {t("plugins.conversationMode.exit")}
        </button>
      </div>
      <PluginBoundary key={`${mode.id}:${props.conversationId}`} pluginId={pluginIdFromRegistryKey(mode.id)}>
        <Component key={props.conversationId} {...props} onExit={onExit} setExitBlocked={setExitBlocked} />
      </PluginBoundary>
    </div>
  );
}
