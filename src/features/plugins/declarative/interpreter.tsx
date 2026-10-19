import type { PluginHandle } from "../runtime/context";
import { PluginConfigForm } from "./PluginConfigForm";

/**
 * Tier-0 declarative interpreter (plan §4.1 declarative/interpreter.ts):
 * applies a zero-JS plugin through the same PluginContext surface JS plugins
 * use — theme token overrides, i18n bundles, and a configSchema-driven
 * settings page. (The bundle's styles.css is NOT applied here: the loader
 * injects it via injectBundleCss beforehand — the install-time-reviewed
 * artifact, not a theme-permission-gated API call.) Anything a declarative
 * manifest can express maps to exactly one context call, so unloading needs
 * no special case: the context's disposer stack covers it.
 */
export function applyDeclarativePlugin(handle: PluginHandle): void {
  const { manifest, ctx } = handle;
  for (const theme of manifest.contributes?.themes ?? []) {
    ctx.theme.setTokens(theme.tokens);
  }
  for (const bundle of manifest.contributes?.i18n ?? []) {
    ctx.i18n.addBundle(bundle.lang, bundle.ns ?? `plugin-${manifest.id}`, bundle.resources);
  }
  if (manifest.configSchema) {
    const schema = manifest.configSchema;
    ctx.ui.registerSettingsSection({
      label: () => manifest.name,
      component: () => <PluginConfigForm ctx={ctx} schema={schema} />,
    });
  }
  for (const item of manifest.contributes?.statusBarItems ?? []) {
    const text = item.text;
    ctx.ui.registerStatusBarItem({
      key: item.key,
      component: function DeclarativeStatusChip() {
        return <span className="text-text-tertiary">{text}</span>;
      },
    });
  }
  for (const command of manifest.contributes?.commands ?? []) {
    const topic = command.emits ?? `plugin:${manifest.id}:command:${command.key}`;
    ctx.ui.registerCommand({
      key: command.key,
      title: () => command.title,
      run: () => ctx.events.emit(topic, { command: command.key }),
    });
  }
}
