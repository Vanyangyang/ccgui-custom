import type * as Pub from "../plugin";
import type {
  ComposerSlotId,
  Disposer,
  JsonSchemaObject,
  JsonSchemaProperty,
  PluginContext,
  PluginConversationProps,
  PluginAgentCatalogEntry,
  HostChatTarget,
  HostChatIdentity,
  HostChatSession,
  HostChatReceipt,
  HostChatSubmission,
  HostChatActivationEvent,
  HostTasksApi,
  HostTaskReceipt,
  HostTaskSubmission,
  HostTaskSelection,
  PluginDetachedSurfaceDefinition,
  HostTaskPlan,
  HostTaskPlanRequest,
  HostTaskCatalog,
  HostTaskHistoryPage,
  HostTaskExcerpt,
  PluginManifest,
  PluginTier,
  SessionMenuTarget,
} from "./index";

/**
 * 契约漂移守卫（纯类型层面，无运行时代码；经 tsconfig include 参与
 * typecheck，刻意不从 barrel 导出）。
 *
 * 包根 plugin.d.ts 是插件作者面对的公共 API 镜像（VS Code 的 vscode.d.ts
 * 同款模式），必须与 src/* 的宿主侧定义保持同步：任何一侧增删/改形，
 * 本文件即编译错误。
 *
 * 两个断言维度：
 * - Mutual：双向可赋值（结构等价），用于无组件字段的纯数据类型。
 * - KeyParity：key 集合完全一致（增删方法即失败），用于 PluginContext
 *   各能力组。ui 组含组件类型——plugin.d.ts 用独立的 ComponentLike 而
 *   宿主侧用 React ComponentType（刻意分歧，blob bundle 无法共享 React
 *   类型身份），故含组件的组只校 key 不校赋值。
 */

/** T 必须为 true 才能实例化；false 落在 extends 约束外即编译错误。 */
type Assert<T extends true> = T;

/** A 与 B 双向可赋值。元组包裹避免联合类型的分配律干扰。 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** A 与 B 的 key 集合完全一致（双向子集）。 */
type KeyParity<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;

// --- 纯数据类型：双向可赋值 -------------------------------------------------

type _PluginManifest = Assert<Mutual<PluginManifest, Pub.PluginManifest>>;
type _JsonSchemaObject = Assert<Mutual<JsonSchemaObject, Pub.JsonSchemaObject>>;
type _JsonSchemaProperty = Assert<Mutual<JsonSchemaProperty, Pub.JsonSchemaProperty>>;
type _ComposerSlotId = Assert<Mutual<ComposerSlotId, Pub.ComposerSlotId>>;
type _SessionMenuTarget = Assert<Mutual<SessionMenuTarget, Pub.SessionMenuTarget>>;
type _PluginTier = Assert<Mutual<PluginTier, Pub.PluginTier>>;
type _Disposer = Assert<Mutual<Disposer, Pub.Disposer>>;
type _ConversationProps = Assert<Mutual<PluginConversationProps, Pub.PluginConversationProps>>;
type _AgentCatalogEntry = Assert<Mutual<PluginAgentCatalogEntry, Pub.PluginAgentCatalogEntry>>;
type _AgentShape = Assert<Mutual<PluginContext["agent"], Pub.PluginContext["agent"]>>;
type _ChatTarget = Assert<Mutual<HostChatTarget, Pub.HostChatTarget>>;
type _ChatIdentity = Assert<Mutual<HostChatIdentity, Pub.HostChatIdentity>>;
type _ChatSession = Assert<Mutual<HostChatSession, Pub.HostChatSession>>;
type _ChatReceipt = Assert<Mutual<HostChatReceipt, Pub.HostChatReceipt>>;
type _ChatSubmission = Assert<Mutual<HostChatSubmission, Pub.HostChatSubmission>>;
type _ChatActivation = Assert<Mutual<HostChatActivationEvent, Pub.HostChatActivationEvent>>;
type _ChatShape = Assert<Mutual<PluginContext["chat"], Pub.PluginContext["chat"]>>;
type _ConversationsShape = Assert<Mutual<Omit<PluginContext["conversations"], "View">, Omit<Pub.PluginContext["conversations"], "View">>>;
type _ConversationsKeys = Assert<KeyParity<PluginContext["conversations"], Pub.PluginContext["conversations"]>>;
type _ImagesShape = Assert<Mutual<PluginContext["images"], Pub.PluginContext["images"]>>;
type _ImagesKeys = Assert<KeyParity<PluginContext["images"], Pub.PluginContext["images"]>>;
type _TasksShape = Assert<Mutual<HostTasksApi, Pub.HostTasksApi>>;
type _TasksContext = Assert<Mutual<PluginContext["tasks"], Pub.PluginContext["tasks"]>>;
type _MemoryExtraction = Assert<Mutual<PluginContext["memoryExtraction"], Pub.PluginContext["memoryExtraction"]>>;
type _MemoryBatch = Assert<Mutual<import("./memory-extraction").MemoryExtractionBatch, Pub.MemoryExtractionBatch>>;
type _TaskConversationSnapshot = Assert<Mutual<import("./task-conversations").HostTaskConversationSnapshot, Pub.HostTaskConversationSnapshot>>;
type _TaskMessageReceipt = Assert<Mutual<import("./task-conversations").HostTaskMessageReceipt, Pub.HostTaskMessageReceipt>>;
type _TaskConversationAction = Assert<Mutual<import("./task-conversations").HostTaskConversationAction, Pub.HostTaskConversationAction>>;
type _TaskReceipt = Assert<Mutual<HostTaskReceipt, Pub.HostTaskReceipt>>;
type _TaskSubmission = Assert<Mutual<HostTaskSubmission, Pub.HostTaskSubmission>>;
type _TaskSelection = Assert<Mutual<HostTaskSelection, Pub.HostTaskSelection>>;
type _DetachedDefinition = Assert<Mutual<PluginDetachedSurfaceDefinition, Pub.PluginDetachedSurfaceDefinition>>;
type _TaskPlan = Assert<Mutual<HostTaskPlan, Pub.HostTaskPlan>>;
type _TaskPlanRequest = Assert<Mutual<HostTaskPlanRequest, Pub.HostTaskPlanRequest>>;
type _TaskCatalog = Assert<Mutual<HostTaskCatalog, Pub.HostTaskCatalog>>;
type _TaskHistory = Assert<Mutual<HostTaskHistoryPage, Pub.HostTaskHistoryPage>>;
type _TaskExcerpt = Assert<Mutual<HostTaskExcerpt, Pub.HostTaskExcerpt>>;

// --- PluginContext：顶层与各能力组 key 完全对齐 ------------------------------

type _ContextKeys = Assert<KeyParity<PluginContext, Pub.PluginContext>>;
type _UiKeys = Assert<KeyParity<PluginContext["ui"], Pub.PluginContext["ui"]>>;
type _ThemeKeys = Assert<KeyParity<PluginContext["theme"], Pub.PluginContext["theme"]>>;
type _I18nKeys = Assert<KeyParity<PluginContext["i18n"], Pub.PluginContext["i18n"]>>;
type _StorageKeys = Assert<KeyParity<PluginContext["storage"], Pub.PluginContext["storage"]>>;
type _EventsKeys = Assert<KeyParity<PluginContext["events"], Pub.PluginContext["events"]>>;
type _ComposerKeys = Assert<KeyParity<PluginContext["composer"], Pub.PluginContext["composer"]>>;
type _WorkspacesKeys = Assert<KeyParity<PluginContext["workspaces"], Pub.PluginContext["workspaces"]>>;
type _SessionsKeys = Assert<KeyParity<PluginContext["sessions"], Pub.PluginContext["sessions"]>>;
type _BridgeKeys = Assert<KeyParity<PluginContext["bridge"], Pub.PluginContext["bridge"]>>;
type _HostKeys = Assert<KeyParity<PluginContext["host"], Pub.PluginContext["host"]>>;

// --- 无组件字段的能力组：进一步要求双向可赋值 --------------------------------

type _ThemeShape = Assert<Mutual<PluginContext["theme"], Pub.PluginContext["theme"]>>;
type _I18nShape = Assert<Mutual<PluginContext["i18n"], Pub.PluginContext["i18n"]>>;
type _StorageShape = Assert<Mutual<PluginContext["storage"], Pub.PluginContext["storage"]>>;
type _EventsShape = Assert<Mutual<PluginContext["events"], Pub.PluginContext["events"]>>;
type _ComposerShape = Assert<Mutual<PluginContext["composer"], Pub.PluginContext["composer"]>>;
type _WorkspacesShape = Assert<Mutual<PluginContext["workspaces"], Pub.PluginContext["workspaces"]>>;
type _SessionsShape = Assert<Mutual<PluginContext["sessions"], Pub.PluginContext["sessions"]>>;
type _BridgeShape = Assert<Mutual<PluginContext["bridge"], Pub.PluginContext["bridge"]>>;
type _HostShape = Assert<Mutual<PluginContext["host"], Pub.PluginContext["host"]>>;
