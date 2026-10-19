import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Key } from "react";
import { Input } from "@/components/base/input/input";
import { Select, SelectItem } from "@/components/base/select/select";
import { Switch } from "@/components/base/switch/switch";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import type { PluginContext } from "@ccgui/plugin-sdk";
import type { JsonSchemaObject, JsonSchemaProperty } from "@ccgui/plugin-sdk";

/** Topic emitted (with {pluginId, key, value}) whenever a config form writes
 *  a value — pluginId distinguishes co-loaded configSchema plugins. */
export const CONFIG_CHANGED_TOPIC = "plugin-config://changed";

const SELECT_TRIGGER = "h-8 w-auto gap-1 rounded-lg px-2 py-1.5";

function PropertyEditor({
  name,
  prop,
  value,
  onChange,
}: {
  name: string;
  prop: JsonSchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = prop.title ?? name;
  if (prop.enum && prop.enum.length > 0) {
    return (
      <SettingsRow label={label} description={prop.description}>
        <Select
          aria-label={label}
          selectedKey={String(value ?? prop.default ?? prop.enum[0])}
          onSelectionChange={(key: Key | null) => {
            if (key == null) return;
            const raw = String(key);
            onChange(prop.enum!.find((e) => String(e) === raw) ?? raw);
          }}
          triggerClassName={SELECT_TRIGGER}
        >
          {prop.enum.map((option) => (
            <SelectItem key={String(option)} id={String(option)}>
              {String(option)}
            </SelectItem>
          ))}
        </Select>
      </SettingsRow>
    );
  }
  if (prop.type === "boolean") {
    return (
      <SettingsRow label={label} description={prop.description}>
        <Switch
          size="sm"
          aria-label={label}
          isSelected={Boolean(value ?? prop.default ?? false)}
          onChange={(next) => onChange(next)}
        />
      </SettingsRow>
    );
  }
  if (prop.type === "number" || prop.type === "integer") {
    return (
      <SettingsRow label={label} description={prop.description}>
        <Input
          aria-label={label}
          type="number"
          size="small"
          className="w-28"
          value={String(value ?? prop.default ?? "")}
          onChange={(text) => onChange(text === "" ? null : Number(text))}
        />
      </SettingsRow>
    );
  }
  return (
    <SettingsRow label={label} description={prop.description}>
      <Input
        aria-label={label}
        size="small"
        className="w-64"
        value={String(value ?? prop.default ?? "")}
        onChange={(text) => onChange(text)}
      />
    </SettingsRow>
  );
}

/**
 * configSchema-driven settings form (plan §5.3): declarative plugins get a
 * real settings page without shipping JS. Values persist through the
 * plugin's KV namespace; every write emits `plugin-config://changed` on the
 * plugin bus (payload carries pluginId) so a co-loaded JS companion (or the
 * host) can react.
 */
export function PluginConfigForm({
  ctx,
  schema,
}: {
  ctx: PluginContext;
  schema: JsonSchemaObject;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const properties = Object.entries(schema.properties ?? {});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Per-key KV reads are independent — start them together instead of
      // serializing one round-trip per property.
      const loaded: Record<string, unknown> = Object.fromEntries(
        await Promise.all(
          properties.map(
            async ([name]): Promise<[string, unknown]> => [name, await ctx.storage.get(`config.${name}`)],
          ),
        ),
      );
      if (!cancelled) setValues(loaded);
    })();
    return () => {
      cancelled = true;
    };
    // Schema is static for a plugin's lifetime; load once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  if (!values) return null;
  if (properties.length === 0) {
    return <div className="text-body-medium text-text-secondary">{t("plugins.configEmpty")}</div>;
  }
  return (
    <div className="flex w-full flex-col gap-6">
      <SettingsSectionLabel>{t("plugins.configLabel")}</SettingsSectionLabel>
      <SettingsCard>
        {properties.map(([name, prop]) => (
          <PropertyEditor
            key={name}
            name={name}
            prop={prop}
            value={values[name]}
            onChange={(value) => {
              setValues({ ...values, [name]: value });
              void ctx.storage.set(`config.${name}`, value);
              ctx.events.emit(CONFIG_CHANGED_TOPIC, { pluginId: ctx.pluginId, key: name, value });
            }}
          />
        ))}
      </SettingsCard>
    </div>
  );
}
