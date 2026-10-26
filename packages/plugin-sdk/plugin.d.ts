/**
 * @ccgui/plugin-sdk — 插件侧公共契约声明（VS Code 的 vscode.d.ts 同款模式：
 * 本文件是插件作者面对的公共 API 定义，与 src/ 同包维护、同版本发布；
 * 双向漂移由 src/contract-check.ts 在类型层面把守）。
 *
 * 插件仓用法（包未发布 npm 前的过渡方案）：复制本文件为插件仓的
 * `src/ccgui-plugin.d.ts`，首行版本戳必须与所用宿主 SDK 一致。
 *
 * @ccgui/plugin-sdk v0.3.28
 */

/** 宿主实现的 SDK 契约版本。 */
export declare const SDK_VERSION: string;

/** 每次注册的撤销句柄；卸载时逆序执行。 */
export type Disposer = () => void;

/** Supplementary native system/developer guidance; does not grant permissions.
 * Omission retains the last profile. Changes wait for a full native turn. */
export interface HostFixedInstructions {
  /** [A-Za-z0-9._:-]{1,128}. */
  version: string;
  /** Nonblank, <=16000 UTF-16 units, no NUL. */
  text: string;
}

export interface MemoryExtractionSource { kind: "conversation" | "coordination"; id: string }
export interface MemoryExtractionSessionRef { engine: string; sessionId: string; workspacePath: string }
/** Persist unchanged: native seq, code-point offset (0 means row consumed), digest. */
export interface MemoryExtractionCursor { sessionId: string; seq: number; offset: number; rowDigest?: string }
export interface MemoryExtractionContext { id: string; revision: number; kind: string; title: string; text: string; conditions: string[]; authority?: string; updatedAt?: string }
export interface MemoryExtractionRelation { kind: "supersedes" | "conflicts"; targetId: string; targetRevision: number; reason: string }
export interface MemoryExtractionEvidence { seq: number; role: "user" | "assistant"; quote: string }
export interface MemoryExtractionNote {
  kind: "decision" | "idea" | "observation" | "hypothesis" | "handoff";
  title: string; text: string; conditions: string[]; relatedIds: string[]; evidence: MemoryExtractionEvidence[];
  relations?: MemoryExtractionRelation[];
}
export interface MemoryExtractionBatch {
  version: 1 | 2; projectId: string; source: MemoryExtractionSource; sessionRef: MemoryExtractionSessionRef;
  fromCursor: MemoryExtractionCursor | null; nextCursor: MemoryExtractionCursor; inputDigest: string;
  partial: boolean; hasMore: boolean; model: "gemini-4-argon"; notes: MemoryExtractionNote[];
}
export interface MemoryExtractionDeferred { status: "deferred" | "unavailable" | "invalid_source"; reason: string; retryAfterMs: number }
export type MemoryExtractionResult = { status: "completed"; batch: MemoryExtractionBatch } | { status: "empty"; cursor: MemoryExtractionCursor | null } | MemoryExtractionDeferred;
export type MemoryExtractionCheckpoint = { status: "ready"; cursor: MemoryExtractionCursor; sessionRef: MemoryExtractionSessionRef } | MemoryExtractionDeferred;
export interface MemoryExtractionStatus { available: boolean; busy: boolean; retryAfterMs: number; reason?: string }
export interface MemoryExtractionSourceRequest { projectId: string; source: MemoryExtractionSource }
export interface MemoryExtractionRequest extends MemoryExtractionSourceRequest { requestId: string; cursor?: MemoryExtractionCursor | null; context?: MemoryExtractionContext[]; formatVersion?: 2; expectedSourceDigest?: string }
export interface MemoryExtractionPrepareRequest extends MemoryExtractionSourceRequest { cursor?: MemoryExtractionCursor | null }
export type MemoryExtractionPreparation = { status: "ready"; query: string; sourceDigest: string; fromCursor: MemoryExtractionCursor | null; nextCursor: MemoryExtractionCursor | null; sessionRef: MemoryExtractionSessionRef; partial: boolean; hasMore: boolean } | MemoryExtractionDeferred;
/** Desktop owner, host:memory plus source host:chat/host:tasks (0.3.25).
 * Fixed tool-less Gemini4/Vertex consumes quota; source is read and verified by
 * the host. Foreground requests cancel background inference. Cancellation does
 * not guarantee upstream quota refunds. Plugins own queues/atomic saves; never
 * automatically promote extracted notes to user-confirmed authority. */
export interface HostMemoryExtractionApi {
  status(): Promise<MemoryExtractionStatus>;
  checkpoint(request: MemoryExtractionSourceRequest): Promise<MemoryExtractionCheckpoint>;
  prepare(request: MemoryExtractionPrepareRequest): Promise<MemoryExtractionPreparation>;
  extract(request: MemoryExtractionRequest): Promise<MemoryExtractionResult>;
  cancel(requestId: string): Promise<void>;
}

export type ConversationEngine = "claude" | "codex";
export interface ConversationSelection { engine: ConversationEngine; model?: string; effort?: string; providerId?: string }
export interface ConversationSnapshot {
  threadId: string; revision: number; workspacePath: string;
  selection: ConversationSelection; effectiveSelection: ConversationSelection;
  sessionRef: { engine: ConversationEngine; sessionId: string; workspacePath: string } | null;
  status: "idle" | "starting" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  /** Transient host Message projection; never persist or rewrite in plugin state. */
  messages: unknown[]; error?: string; lastRequestId?: string;
}
export interface PluginImageAttachment {
  id: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
}
export interface HostImagesApi {
  importImage(request: { dataBase64: string; mimeType: string; name?: string }): Promise<PluginImageAttachment>;
  readPreview(id: string): Promise<{ dataUrl: string }>;
}
export interface ConversationCatalog {
  defaultEngine?: string;
  capabilities?: { images: boolean; fixedInstructions?: boolean };
  engines: Array<{ id: ConversationEngine; label: string; available: boolean; supportsImages?: boolean;
    models: Array<{ id: string; label: string }>; providers: Array<{ id: string; label: string }>; efforts?: Array<{ id: string; label: string }>;
    defaultModel: string | null; defaultEffort: string | null; defaultProviderId: string }>;
  workspaces: Array<{ id: string; path: string; name: string }>;
}
export interface ConversationViewProps { conversation: unknown; readOnly?: boolean; onAction?: (action: ConversationViewAction) => void }
export type ConversationViewAction = { type: "openFile"; path: string; sourceId?: string; expectedRevision?: number } | HostTaskConversationAction;
export type ConversationViewComponent = ComponentLike<ConversationViewProps>;
/** Desktop owner only, host:chat. Persistent read-only discussion branches;
 * immutable workspace/selection, no execution mode, no task ledger. */
export interface HostConversationsApi {
  catalog(): Promise<ConversationCatalog>;
  open(request: { threadId: string; workspacePath: string; selection: ConversationSelection }): Promise<ConversationSnapshot>;
  inspect(threadId: string): Promise<ConversationSnapshot>;
  send(request: { threadId: string; requestId: string; expectedRevision: number; prompt: string; images?: string[]; fixedInstructions?: HostFixedInstructions }): Promise<ConversationSnapshot>;
  stop(threadId: string): Promise<ConversationSnapshot>;
  openFile(threadId: string, path: string): Promise<void>;
  onEvent(callback: (snapshot: ConversationSnapshot) => void): Disposer;
}

export interface WorkspaceProjectMemberDefinition {
  id: string;
  path: string;
  label: string;
  /** Descriptive role; does not enforce OS-level read-only access. */
  role: "development" | "reference";
}
export interface WorkspaceProjectDefinition {
  name: string;
  defaultPath: string;
  members: WorkspaceProjectMemberDefinition[];
}
export interface PublishedWorkspaceProject {
  id: string;
}

export interface PluginDetachedAction {
  name: string;
  args: unknown[];
}
export interface PluginDetachedSnapshot {
  revision: number;
  state: unknown;
}
/** Floating renderer props. Actions run only in the original main document;
 * unknown outcomes must never be automatically submitted again. */
export interface PluginDetachedSurfaceProps {
  snapshot: unknown;
  /** After queued actions drain, false preserves unconfirmed renderer edits. */
  registerReturnGuard(guard: () => boolean): Disposer;
  dispatch(action: PluginDetachedAction): Promise<{
    sequence: number;
    value: unknown;
    snapshot: PluginDetachedSnapshot;
  }>;
}
/** Named main.js export; creates only a view, never a second activation. */
export type PluginDetachedRenderer = (context: { react: typeof import("react"); ConversationView?: ConversationViewComponent; Images?: HostImagesApi }) => ComponentLike<PluginDetachedSurfaceProps>;
/** Desktop-only, permission ui:detached-window. Controller/drafts/side effects
 * remain in main; JSON snapshots/actions cross the native window boundary. */
export interface PluginDetachedSurfaceDefinition {
  /** Initial mode when no saved user preference exists; registration alone does not open it. */
  defaultPresentation?: "docked" | "detached";
  rendererExport: string;
  getSnapshot(): unknown;
  subscribe(listener: () => void): Disposer;
  dispatch(action: PluginDetachedAction): unknown | Promise<unknown>;
}

export type PluginConversationProps = {
  conversationId: string;
  workspacePath: string;
  language: string;
  onExit: () => void;
  setExitBlocked?: (blocked: boolean) => void;
};

export interface PluginAgentCatalogEntry {
  engine: string;
  label: string;
  available: boolean;
  readOnly: boolean;
  providers: { id: string; label: string }[];
  models: { id: string; label: string }[];
}

/** Exact host desktop document/window identity, even without a current chat. */
export interface HostChatIdentity {
  readonly clientInstanceId: string;
  readonly windowId: string;
}
/** Exact host-provided desktop timeline identity; never infer it from cwd. */
export interface HostChatTarget extends HostChatIdentity {
  readonly client: "ccgui";
  readonly engine: string;
  readonly nativeSessionId: string;
  readonly guiSessionId: string;
  readonly workspacePath: string;
}
export interface HostChatSession extends HostChatTarget {
  readonly status: "idle" | "busy" | "awaiting_permission";
}
export type HostChatReceiptStatus = "queued" | "received" | "executing" |
  "awaiting_permission" | "awaiting_cost_approval" | "completed" | "failed" | "unknown";
export interface HostChatReceipt {
  readonly requestId: string;
  readonly target: HostChatTarget;
  readonly runId: string;
  readonly status: HostChatReceiptStatus;
  readonly acceptedAt: number;
  readonly updatedAt: number;
  readonly text?: string;
  /** Bounded prefix only; full output remains in the original GUI timeline. */
  readonly truncated?: boolean;
  readonly error?: string;
}
export interface HostChatSubmission {
  requestId: string;
  target: HostChatTarget;
  prompt: string;
}
/** Host task routing and delivery (`host:tasks`, desktop, 0.3.20). Tasks run
 * as real GUI chat turns with the user's settings; write paths are a declared
 * scope for conflict ordering, not an OS sandbox. */
export interface HostTaskSessionRef {
  readonly engine: string;
  readonly sessionId: string;
  readonly workspacePath: string;
}

export interface HostTaskCatalogEngine {
  readonly id: string;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly supportsImages?: boolean;
  readonly supportsFixedInstructions?: boolean;
  /** The user's current default model/effort for new chats of this engine. */
  readonly defaultModel: string | null;
  readonly defaultEffort: string | null;
  /** This engine can run the isolated planner used by `plan()`. */
  readonly planner: boolean;
  /** Present with `catalog({ includeModels: true })`; null when the catalog could not be read. */
  readonly models?: ReadonlyArray<{ readonly id: string; readonly name: string | null; readonly provider: string }> | null;
}

export interface HostTaskCatalogWorkspace {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly remote: boolean;
  readonly archived: boolean;
  /** Registered, local and not archived: a valid plan candidate/submit target. */
  readonly executable: boolean;
}

export interface HostTaskCatalogProject {
  readonly id: string;
  readonly name: string;
  readonly defaultPath: string;
  /** null = the user's own organization; otherwise the publishing plugin. */
  readonly sourcePluginId: string | null;
  readonly members: ReadonlyArray<{
    readonly id: string;
    readonly path: string;
    readonly label: string;
    readonly role: "development" | "reference";
    readonly status: "available" | "missing" | "changed";
    /** The member path itself is a registered workspace (executable target). */
    readonly registered: boolean;
  }>;
}

export interface HostTaskCatalog {
  readonly capabilities?: { readonly nativeCoordination: boolean; readonly images?: boolean; readonly continuousCoordination?: boolean; readonly fixedInstructions?: boolean };
  readonly defaultEngine: string;
  readonly engines: readonly HostTaskCatalogEngine[];
  readonly workspaces: readonly HostTaskCatalogWorkspace[];
  readonly projects: readonly HostTaskCatalogProject[];
}

export interface HostTaskHistoryQuery {
  /** Exactly one registered workspace; rows are never mixed across roots. */
  workspacePath: string;
  offset?: number;
  /** 1-100, default 50. Newest first. */
  limit?: number;
}

export interface HostTaskHistoryItem extends HostTaskSessionRef {
  readonly title: string;
  /** First-message snippet, at most 160 characters. */
  readonly preview: string;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly messageCount: number;
  readonly pinned: boolean;
  readonly model: string | null;
  readonly effort: string | null;
  readonly open: boolean;
  readonly status: "idle" | "busy" | "awaiting_permission" | "closed";
  /** Native child-task parent, when this chat is a host-managed child. */
  readonly parent: { readonly engine: string; readonly sessionId: string } | null;
  readonly childCount: number;
  /** This plugin's task requests delivered into this chat. */
  readonly taskRequestIds: readonly string[];
}

export interface HostTaskHistoryPage {
  readonly items: readonly HostTaskHistoryItem[];
  readonly total: number;
  readonly nextOffset: number | null;
}

export interface HostTaskExcerptQuery extends HostTaskSessionRef {
  /** Page cursor from a previous excerpt's `nextBefore`; omit for the newest page. */
  before?: number | null;
  /** Raw transcript rows to scan, 1-40 (default 20). Tool rows are skipped. */
  limit?: number;
  /** Total text budget, 1000-24000 characters (default 12000). */
  maxChars?: number;
}

export interface HostTaskExcerpt {
  readonly messages: ReadonlyArray<{ readonly seq: number; readonly role: "user" | "assistant"; readonly text: string; readonly truncated: boolean }>;
  /** Older page cursor; null at the beginning of the conversation. */
  readonly nextBefore: number | null;
  /** True when the budget dropped or clipped rows of this page. */
  readonly truncated: boolean;
}

export interface HostTaskPlanProject {
  /** Stable plugin-chosen id ([A-Za-z0-9._:-]{1,128}); steps reference it. */
  id: string;
  label: string;
  /** A registered, local, non-archived workspace path (exact). */
  workspacePath: string;
  description?: string;
}

export interface HostTaskPlanRequest {
  /** Idempotency key: the same id and input returns the same plan. */
  requestId: string;
  goal: string;
  projects: HostTaskPlanProject[];
  /** Extra data for routing (decisions, constraints). Never executed. */
  context?: string;
  /** Default: the active engine and its current model, when it can plan. */
  planner?: { engine: string; model?: string; effort?: string; providerId?: string };
}

export interface HostTaskPlanStep {
  readonly id: string;
  readonly title: string;
  /** Always one of the request's candidate project ids. */
  readonly projectId: string;
  readonly instruction: string;
  /** Earlier step ids whose results this step needs. */
  readonly dependsOn: readonly string[];
  readonly contextRefs?: readonly string[];
  /** Project-relative, forward-slash paths; [] = read-only; "." = whole project. */
  readonly writePaths?: readonly string[];
}

export interface HostTaskPlan {
  readonly requestId: string;
  readonly status: "ready" | "needs_clarification";
  readonly question?: string;
  readonly steps: readonly HostTaskPlanStep[];
  readonly planner: { readonly engine: string; readonly model: string | null };
  readonly createdAt: number;
}

export type HostTaskPlanErrorCode = "invalid_request" | "planner_unavailable" | "timeout" | "bad_output" | "failed" | "cancelled";

export interface HostTaskPlanRecord {
  readonly requestId: string;
  readonly status: "running" | "ready" | "needs_clarification" | "failed" | "cancelled";
  readonly plan?: HostTaskPlan;
  readonly error?: { readonly code: HostTaskPlanErrorCode; readonly message: string };
  readonly updatedAt: number;
}

export type HostTaskHandoff = { requestId: string } | { session: HostTaskSessionRef };

/** Requested or natively resolved launch configuration, not upstream model telemetry. */
export interface HostTaskSelection {
  readonly engine: string;
  readonly model: string;
  readonly effort: string;
  readonly providerId: string;
}

export interface HostTaskSubmission {
  /** Idempotency key ([A-Za-z0-9._:-]{1,128}); a retry must repeat the exact submission. */
  requestId: string;
  /** Plugin's logical task id (groups steps/attempts). */
  taskId: string;
  /** Logical execution role, scoped by this plugin and projectId; not a single chat forever. */
  slotKey: string;
  projectId: string;
  /** Registered, local, non-archived workspace: the conversation's cwd. */
  workspacePath: string;
  prompt: string;
  /** Requires advertised native support and an explicit supported engine. */
  fixedInstructions?: HostFixedInstructions;
  /** User-authored projection text; native prompt is preserved. */
  displayText?: string;
  /** Declared write scope relative to workspacePath. Omitted = unknown (whole workspace, serialized). [] = read-only. */
  writePaths?: string[];
  /** References the AI should consult on demand (paths, memory ids). Listed, never expanded. */
  contextRefs?: string[];
  /** "auto" reuses the slot's chat when still valid; "new" always starts a chat. */
  sessionMode: "auto" | "new";
  /** Exclusive coordinator reservation from acceptance; requires sessionMode new. */
  coordination?: true;
  /** Adds a bounded handoff note from an earlier task receipt or chat. */
  handoffFrom?: HostTaskHandoff;
  /** Explicit choices must match a reused chat; otherwise a new chat is started. */
  engine?: string;
  model?: string;
  effort?: string;
  /** Exact channel id; requires explicit engine/model/effort (Claude/Codex). */
  providerId?: string;
  /** Up to 8 opaque plugin image attachment IDs owned by this plugin (0.3.23). */
  images?: string[];
}

export type HostTaskStatus = "queued" | "starting" | "executing" | "awaiting_permission" | "completed" | "failed" | "cancelled" | "unknown";

export interface HostTaskReceipt {
  readonly requestedSelection?: HostTaskSelection;
  readonly effectiveSelection?: HostTaskSelection;
  readonly requestId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly projectId: string;
  readonly slotKey: string;
  readonly workspacePath: string;
  /** "starting" = the host may have started the native turn; after a restart it becomes "unknown", never replayed. */
  readonly status: HostTaskStatus;
  readonly sessionDecision: "reused" | "new" | null;
  /** Only native evidence fills this; null while a new chat awaits its session announcement. */
  readonly session: HostTaskSessionRef | null;
  readonly runId: string | null;
  /** Requests whose declared writes or chat this one waits behind. */
  readonly blockedBy?: readonly string[];
  /** This request's assistant output, at most 65,536 characters. */
  readonly text?: string;
  /** Text is a bounded prefix; open() shows the full conversation. */
  readonly truncated?: boolean;
  readonly error?: string;
  readonly acceptedAt: number;
  readonly updatedAt: number;
}

export interface HostTaskSlot {
  readonly projectId: string;
  readonly slotKey: string;
  readonly session: HostTaskSessionRef;
  readonly lastRequestId: string;
  readonly updatedAt: number;
}

export interface HostTaskMessageReceipt {
  conversationRequestId: string;
  requestId: string;
  /** Bounded (280 UTF-16 units, no split surrogate) displayText preview; empty
   * when displayText was omitted. Never generated from a model response. */
  preview: string;
  inputRevision: number;
  status: "queued" | "starting" | "received" | "completed" | "failed" | "cancelled" | "unknown";
  delivery: "queued" | "turn" | "steer" | "live" | null;
  runId: string | null;
  sessionRef: HostTaskSessionRef | null;
  acceptedAt: number;
  updatedAt: number;
  error?: string;
}
export interface HostTaskConversationChild {
  id: string;
  title: string;
  state: string;
  sessionRef: HostTaskSessionRef | null;
  delegation?: { requestId?: string; state: string; result?: string | null };
}
export interface HostTaskConversationSnapshot {
  requestId: string;
  revision: number;
  inputRevision: number;
  workspacePath: string;
  sessionRef: HostTaskSessionRef | null;
  selection?: HostTaskSelection;
  effectiveSelection?: HostTaskSelection;
  status: "starting" | "running" | "waiting" | "idle" | "stopping" | "cancelled" | "failed" | "unknown";
  /** Transient real host rows, including native sequence, timestamps and pending cards. Never persist these projections. */
  messages: unknown[];
  deliveries: HostTaskMessageReceipt[];
  children: HostTaskConversationChild[];
  canSend: boolean;
  /** Sticky stop watch, including when all currently observed runs are cancelled.
   * Cleared only after an explicit new input is natively accepted. */
  stopRequested?: boolean;
  canChangeSelection: boolean;
  error?: string;
}
export interface HostTaskMessageRequest {
  conversationRequestId: string;
  requestId: string;
  expectedInputRevision: number;
  prompt: string;
  fixedInstructions?: HostFixedInstructions;
  /** User-authored display text; native prompt and transcript text are untouched. */
  displayText?: string;
  images?: string[];
}
/** Displayed pending identity is mandatory for mutating native actions. sourceId
 * is a renderer routing hint; the owning request and current native record are
 * independently validated by the host. */
export type HostTaskConversationAction = {
  sourceId?: string;
  conversationRequestId: string;
  expectedRevision: number;
} & (
  | { type: "openFile"; path: string }
  | { type: "openChild"; childId: string }
  | { type: "openNative" }
  | { type: "answerQuestion"; seq: number; runId: string; requestId: string; answers: Record<string, string | string[]> | null }
  | { type: "answerGrant"; seq: number; accept: boolean }
  | { type: "answerPlan"; planId: string; planRevision: number; runId: string | null; decision: "approve" | "request_changes" | "defer"; feedback?: string }
);
export interface HostTaskConversationsApi {
  conversation(requestId: string): Promise<HostTaskConversationSnapshot>;
  sendMessage(request: HostTaskMessageRequest): Promise<HostTaskMessageReceipt>;
  messageReceipt(conversationRequestId: string, requestId: string): Promise<HostTaskMessageReceipt | null>;
  cancelMessage(conversationRequestId: string, requestId: string): Promise<HostTaskMessageReceipt | null>;
  stopConversation(requestId: string): Promise<HostTaskConversationSnapshot>;
  conversationAction(requestId: string, action: HostTaskConversationAction): Promise<HostTaskConversationSnapshot | void>;
  onConversationEvent(callback: (snapshot: HostTaskConversationSnapshot) => void): Disposer;
}

export interface HostTasksApi extends HostTaskConversationsApi {
  catalog(options?: { includeModels?: boolean }): Promise<HostTaskCatalog>;
  history(query: HostTaskHistoryQuery): Promise<HostTaskHistoryPage>;
  excerpt(query: HostTaskExcerptQuery): Promise<HostTaskExcerpt>;
  /** Isolated, tool-less routing call. Rejects with Error whose `code` is a HostTaskPlanErrorCode. */
  plan(request: HostTaskPlanRequest): Promise<HostTaskPlan>;
  getPlan(requestId: string): Promise<HostTaskPlanRecord | null>;
  cancelPlan(requestId: string): Promise<boolean>;
  /** Durable acceptance before resolving; delivery continues in the background. */
  submit(request: HostTaskSubmission): Promise<HostTaskReceipt>;
  receipt(requestId: string): Promise<HostTaskReceipt | null>;
  list(query?: { projectId?: string; slotKey?: string; taskId?: string }): Promise<HostTaskReceipt[]>;
  /** Queued requests are withdrawn; a running turn of this request is interrupted. */
  cancel(requestId: string): Promise<HostTaskReceipt | null>;
  /** Focus the request's conversation (user-initiated). */
  open(requestId: string): Promise<void>;
  /** Prune large assistant output from a settled receipt while retaining its non-replayable tombstone and identity. */
  forget(requestId: string): Promise<boolean>;
  slots(projectId?: string): Promise<HostTaskSlot[]>;
  /** This plugin's receipts only; disposed on unload. */
  onEvent(callback: (receipt: HostTaskReceipt) => void): Disposer;
}
/** Retained `session://activated`: native focus adds exact target metadata;
 * blur keeps selection, background heartbeats never claim attention. */
export interface HostChatActivationEvent {
  engine: string | null;
  sessionId: string | null;
  origin?: "host";
  reason?: "window-focus";
  target?: HostChatSession;
}

/** 信任层级（ADR-1）：declarative = 零 JS 声明式。 */
export type PluginTier = "declarative" | "js";

/** 插件入口唯一约定：main.js 默认导出本函数。 */
export type PluginActivate = (ctx: PluginContext) => void | (() => void);

/** 外部会话源行(ctx.sessions.registerSource,0.3.4 起):插件上报的
 *  远端/容器内会话摘要。workspacePath 必须是已登记工作区的 path,否则
 *  宿主合并时丢弃(侧栏按 workspacePath 分组)。 */
export interface ExternalSessionRow {
  engine: string;
  sessionId: string;
  workspacePath: string;
  title?: string;
  updatedAt?: number | null;
  /** 远端 jsonl 绝对路径(可选;宿主历史回放经远程通道拉取)。 */
  remotePath?: string;
}

export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  default?: unknown;
  enum?: (string | number)[];
}

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/** ccgui.plugin.json（plan §5.1）。 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  /** SDK 兼容区间："^0.3" / "~0.3.0" / ">=0.3.0" / 精确 / "*"（缺省不校验）。 */
  sdkVersion?: string;
  author?: string;
  description?: string;
  tier: PluginTier;
  /** 基座权限与 `network:<host>[…]` / `exec:<bin>` 授权；全集、形状与放行
   *  规则以包内 spec/permissions.json 为单一事实源（TS/Rust/模板校验脚本
   *  三方消费同一文件）。`network:none` 是基座权限（声明无网络），永远
   *  不是授权——它不会放行任何主机。 */
  permissions: string[];
  contributes?: {
    themes?: { name?: string; tokens: { light?: Record<string, string>; dark?: Record<string, string> } }[];
    i18n?: { lang: string; ns?: string; resources: Record<string, unknown> }[];
    statusBarItems?: { key?: string; text: string }[];
    commands?: { key: string; title: string; emits?: string }[];
  };
  configSchema?: JsonSchemaObject;
  /** 市场方形图标：仓库内相对路径（推荐 `docs/icon.png`）或 https URL；
   *  缺省 = 市场用首字母瓷砖。仅索引消费，宿主安装不读。 */
  icon?: string;
  /** 市场详情页效果图：仓库内相对路径或 https URL，≤ 5 张；缺省 = 不渲染图集。 */
  screenshots?: string[];
}

export type ComposerSlotId = "addMenu" | "cliMenu" | "permissionMenu";

/** 侧栏会话右键菜单被打开时所在的会话行。 */
export interface SessionMenuTarget {
  engine: string;
  sessionId: string;
  /** Exact source cwd when known from the clicked row (0.3.22). */
  workspacePath?: string;
}

export type ComponentLike<P = Record<string, never>> = (props: P) => unknown;

/** 插件唯一能力门面（plan §5.2）。每个 register* 需要对应权限声明，
 *  返回 Disposer；未显式回收也由宿主 disposer 栈兜底。 */
export interface PluginContext {
  pluginId: string;
  version: string;
  /** 宿主共享 React：宿主树容器组件经它创建（createElement/useRef/...）；
   *  插件自有子树用自己的 createRoot 挂进容器（双段挂载模式）。 */
  react: typeof import("react");
  ui: {
    /** SDK 0.3.18, ui:center-tab. Opt in center tabs/selected side panel to
     * self-update closure. Floating inputs drain through their return guard
     * first. Freeze new actions and durably save drafts in prepare; reject on
     * failure and honor signal across awaits. resume releases that freeze on
     * cancellation/failure and must be idempotent. One handler per plugin;
     * plugin stays loaded; remembered views restore when maintenance ends,
     * explicitly closed views stay closed. Pages are excluded.
     * Loaded handlers also prepare with closed views to settle background work. */
    registerUpdateCloseHandler(def: {
      prepare(signal: AbortSignal): Promise<void>;
      resume(): void;
    }): Disposer;
    registerConversationMode(def: {
      key?: string;
      label: () => string;
      component: ComponentLike<PluginConversationProps>;
    }): Disposer;
    /** 设置页 section（权限 ui:settings-section）。 */
    registerSettingsSection(def: {
      key?: string;
      label: () => string;
      icon?: ComponentLike<{ className?: string }>;
      component: ComponentLike;
    }): Disposer;
    /** Composer「Add」菜单行（权限 ui:add-menu）。 */
    registerAddMenuRow(def: {
      key?: string;
      label: () => string;
      description?: () => string;
      icon?: ComponentLike<{ className?: string }>;
      onSelect: () => void;
    }): Disposer;
    /** Composer 工具栏插槽额外控件（权限 ui:composer-status；历史上曾要求
     *  不存在的 `ui:composer`，1.0.4 及更早版本据此拒绝一切声明，现已随
     *  spec/permissions.json 收敛为同一权限字符串）。 */
    registerComposerSlot(def: {
      slot: ComposerSlotId;
      key?: string;
      component: ComponentLike;
      order?: number;
    }): Disposer;
    /** 聊天右侧面板 tab（权限 ui:panel-tab）。插件 tab 在页签条里只渲染
     *  图标，`icon` 即用户看到的主体；缺省时回落插件素材 / 首字母瓷砖，
     *  `label` 作为 title 与可访问名。 */
    registerPanelTab(def: {
      key?: string;
      label: () => string;
      icon?: ComponentLike<{ className?: string }>;
      component: ComponentLike<{ workspacePath: string }>;
      order?: number;
    }): Disposer;
    /** 应用底部状态栏条目（权限 ui:status-bar）。 */
    registerStatusBarItem(def: {
      key?: string;
      component: ComponentLike;
      order?: number;
      /** 摆放区域（0.3.8 起）："start" = 左对齐区；缺省/"end" =
       *  同步状态之后、版本号之前的既有槽位。 */
      zone?: "start" | "end";
    }): Disposer;
    /** Composer 状态行条目（权限 ui:composer-status，0.3.9 起）：渲染在
     *  输入框状态行（分支/上下文用量那一行）左组、分支切换器之后。 */
    registerComposerStatusItem(def: {
      key?: string;
      component: ComponentLike;
      order?: number;
    }): Disposer;
    /** ⌘K 命令面板命令（权限 ui:command）。 */
    registerCommand(def: {
      key: string;
      title: () => string;
      keywords?: () => string[];
      run: () => void;
    }): Disposer;
    /** 侧栏会话右键菜单追加行（权限 ui:session-menu，0.3.5 起）；
     *  run 收到打开菜单的会话；0.3.22 在已知时提供原 workspacePath，不可用当前聊天代填。 */
    registerSessionMenuItem(def: {
      key?: string;
      label: () => string;
      icon?: ComponentLike<{ className?: string }>;
      danger?: boolean;
      run: (target: SessionMenuTarget) => void;
    }): Disposer;
    /** 跳转到本插件的设置页（权限 `ui:settings-section`，0.3.6 起）。
     *  `key` 对应 registerSettingsSection 的子 key，省略时打开主 section；
     *  供状态栏 chip、面板按钮等做深链入口。 */
    openSettings(key?: string): void;
    /** Markdown 渲染管线追加（权限 ui:markdown）。 */
    registerMarkdownRenderer(def: {
      key?: string;
      remarkPlugins?: unknown[];
      rehypePlugins?: unknown[];
      components?: Record<string, unknown>;
    }): Disposer;
    /** 覆盖层页面，路由 `#/p/<id>`（权限 ui:page）。 */
    registerPage(def: {
      key?: string;
      title: () => string;
      component: ComponentLike;
    }): Disposer;
    /** 自定义 timeline 行 kind 渲染器（权限 ui:timeline-row）。 */
    registerTimelineRowRenderer(def: {
      kind: string;
      key?: string;
      component: ComponentLike<{ row: { kind: string } }>;
    }): Disposer;
    /** 首页侧栏导航入口，位于内建「自动化」之下（权限 ui:sidebar-entry，
     *  0.3.12 起）。onOpen 通常经 openCenterTab 打开本插件的中心页签。 */
    registerSidebarNav(def: {
      key?: string;
      label: () => string;
      icon?: ComponentLike<{ className?: string }>;
      order?: number;
      onOpen: () => void;
    }): Disposer;
    /** 中心页签定义（权限 ui:center-tab，0.3.12 起）：与会话/文件/浏览器
     *  页签共享中部页签条；打开经 openCenterTab。 */
    registerCenterTab(def: {
      key?: string;
      title: () => string;
      icon?: ComponentLike<{ className?: string }>;
      component: ComponentLike;
      order?: number;
      /** Renderer-only native pop-out; also requires ui:detached-window. */
      detached?: PluginDetachedSurfaceDefinition;
    }): Disposer;
    /** 打开（或聚焦）本插件已注册的中心页签（权限 ui:center-tab，
     *  0.3.12 起）；页签未注册时抛错——打开失败必须可见。 */
    openCenterTab(key?: string): void;
  };
  theme: {
    /** 注入样式表（权限 theme）；拒绝 @import/远程 url。 */
    injectCss(css: string): Disposer;
    /** BoardUI token 覆盖快捷方式；key 必须是 --* 自定义属性。 */
    setTokens(tokens: { light?: Record<string, string>; dark?: Record<string, string> }): Disposer;
    /**
     * 插件可消费的宿主 token 公开契约见 @ccgui/plugin-ui 的
     * PLUGIN_UI_TOKEN_CONTRACT（packages/plugin-ui/src/tokens.ts）：清单内
     * 的 --color-…、--gradient-… 等变量宿主承诺不重命名、不删除，插件样式
     * 可安全 var() 引用（建议带 fallback）。做界面优先用 @ccgui/plugin-ui
     * 组件包，而不是手搓样式或猜变量名。
     */
  };
  i18n: {
    /** 注册语言包（权限 i18n）。 */
    addBundle(lang: string, ns: string, resources: Record<string, unknown>): Disposer;
  };
  storage: {
    /** 每插件 KV（权限 storage）。 */
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  events: {
    /** 事件总线（权限 events）。宿主话题：`usage://updated`（引擎 usage
     *  事件透传，payload 为完整 EngineEventPayload `{ runId, sessionId,
     *  engine, seq, kind, data, ts?, genMs? }`，data 是引擎原始 usage JSON；
     *  Claude 原生运行中每次响应结束的用量也经此话题以 kind=usage 发送，
     *  不代表后台任务或整个运行已结束）；
     *  `usage://done`（0.3.8 起，引擎 done 事件透传，data.usage 携带
     *  该轮最终用量——claude/grok 等只经 Done 上报用量的引擎由此对插件
     *  可见；Claude 的最终 done 可在上述响应用量之后携带 null，不重复累计）；
     *  `session://activated`（0.3.8 起，活动会话切换，payload
     *  `{ engine, sessionId }`，pending 标签 sessionId 为 null，无活动
     *  标签时两者皆 null）；`composer://draft`（payload { text }，草稿
     *  变化/清空/会话切换均发射）。
     *
     *  `genMs`（0.3.15 起，仅 `usage`/`done` 携带）：该报告对应的宿主实测
     *  生成窗口毫秒——从响应流打开到流关闭，工具执行、用户等待与轮间隔
     *  全部排除。插件按 `output tokens ÷ genMs` 即得不含工具等待的生成速度；
     *  字段缺失（旧宿主 / 未计时的报告）时回退相邻报告 `ts` 间隔。 */
    on(topic: string, cb: (data: unknown) => void): Disposer;
    emit(topic: string, data: unknown): void;
  };
  /** 聊天输入框(composer)草稿写入(权限 composer:draft,0.3.2 起)。
   *  写入即替换当前活动会话的草稿;不触发发送——发送永远是用户动作。 */
  composer: {
    setDraft(text: string): void;
  };
  /** 工作区登记(权限 host:workspace,0.3.3 起)。把任意路径登记为侧栏
   *  工作区——不要求本机存在该目录(如经 ssh 管理的远程机/WSL 发行版内
   *  路径)。meta 透传存储在宿主工作区行上(如 { wsl: { hostId, distro } }),
   *  会话/文件等宿主能力按需消费;形状由写入方与消费方约定。
   *
   *  meta 携带 `wsl` 键(远程工作区,宿主引擎经 ssh 把会话流量导到
   *  meta.wsl 指定的主机与发行版)需要额外权限 `host:workspace:remote`
   *  (0.3.4 起)——这等效于出网 + 远程执行导向,远超登记一行侧栏数据。
   *  信任权衡:远程通道首连采用 StrictHostKeyChecking=accept-new
   *  (首连自动记录 host key,之后变更才拒绝),插件作者应知晓这是
   *  TOFU 而非严格 pinning。 */
  workspaces: {
    add(path: string, meta?: Record<string, unknown>): Promise<void>;
    /** Publish this plugin's stable project view (host:workspace, 0.3.19).
     * sourceKey may be an existing project UUID. Members must be within
     * registered local workspaces; no access, cwd or memory changes occur.
     * Projection persists after unload and can be removed by the user. */
    publishProject(sourceKey: string, definition: WorkspaceProjectDefinition): Promise<PublishedWorkspaceProject>;
  };
  /** 会话打开 + 外部会话源(权限 host:session;selectSession 0.3.3 起,
   *  registerSource 0.3.4 起)。registerSource:登记异步会话源,宿主在会话
   *  目录刷新时调用 list() 并把行合并进侧栏列表——本机扫描结果优先,同
   *  engine/sessionId/workspacePath 的外部行被丢弃。返回 Disposer,插件
   *  卸载时自动注销。 */
  sessions: {
    selectSession(engine: string, sessionId: string, workspacePath: string): Promise<void>;
    /** 请求宿主立即刷新会话目录（侧栏/标签页），0.3.7 起。
     *  插件绕过宿主直写会话数据（如 sqlite custom_title、转录 title 行）后
     *  调用——否则变更要等用户手动同步或下次常规刷新才可见。 */
    refresh(): Promise<void>;
    /** 修改已有会话的 effort 档位，0.3.10 起。直写宿主会话状态并持久化
     *  （等价于用户在会话内切换档位，refreshSessions 不会回滚）。未知会话
     *  或空 effort 以 rejection 失败——不会创建幽灵会话条目。 */
    setEffort(engine: string, sessionId: string, workspacePath: string, effort: string): Promise<void>;
    registerSource(def: {
      /** 源 id,插件内唯一;同 id 重复登记覆盖(热重载语义)。 */
      id: string;
      list: () => Promise<ExternalSessionRow[]>;
    }): Disposer;
  };
  /** Desktop `host:chat`: only open, loaded existing timelines. Acceptance is
   * persisted per plugin before resolving. Busy targets queue without stop;
   * all restored nonterminal requests (queued included) become unknown on
   * same-document plugin recreation and never replay. Live busy queues work
   * normally. Terminal results require matching run ACK and native session
   * proof (a null-session Claude ACK waits for the native announcement/envelope).
   * Private durable start fencing is not public executing status; that needs
   * matching ACK or native start evidence. Proven pre-spawn busy stays queued.
   * Ledgers are scoped by plugin AND document. A new document preserves but cannot load or
   * replay old records (the pinned caller reports unknown/unreachable).
   * Preserves original model/effort/provider and GUI permission/question flow. */
  conversations: HostConversationsApi & { View: ConversationViewComponent };
  /** Durable host-managed plugin image attachments (`host:chat` or `host:tasks`, 0.3.23). */
  images: HostImagesApi;
  chat: {
    /** Exact desktop identity even when current() is null; scopes plugin KV. */
    identity(): Promise<HostChatIdentity>;
    current(): Promise<HostChatSession | null>;
    inspect(target: HostChatTarget): Promise<HostChatSession | null>;
    submit(request: HostChatSubmission): Promise<HostChatReceipt>;
    /** Current plugin/document only. Null can mean old/unknown/unreachable;
     * never treat it as permission to replay or resubmit to a new target. */
    receipt(requestId: string): Promise<HostChatReceipt | null>;
    onEvent(callback: (receipt: HostChatReceipt) => void): Disposer;
  };
  /** Goal routing and task delivery into real GUI chats (`host:tasks`,
   * desktop only, 0.3.20). Reuses the slot's chat or creates a background chat
   * in a registered local workspace; never changes an existing chat's cwd;
   * a request that may have started is never replayed (restart = unknown). */
  tasks: HostTasksApi;
  /** Project-scoped background inference, desktop owner only. */
  memoryExtraction: HostMemoryExtractionApi;
  /** Agent 轮次（权限 `agent`，0.3.13 起）：经宿主引擎管线拉起 agent
   *  进程——渠道注入、进程注册与聊天发送同构。事件经 `agent://<pluginId>`
   *  总线话题推送（ctx.events.on 订阅；原样透传的引擎事件信封，
   *  kind ∈ delta | tool | usage | done | error …，消费方必须忽略不认识的
   *  kind）。Claude 的用量：CLI 已报告会话状态事件、或响应结束时仍有后台
   *  任务（旧版 CLI 的 task_started is_backgrounded=true 也算）时，每次响应
   *  的用量在 `turn_complete` 的 `data.usage` 上出现一次且不在 `done` 重复，
   *  终态 `done.data.usage` 可为 null，也可能带一个尚未上报过的响应用量
   *  （累计请合计所有 turn_complete 与非 null 的 done）；只有既不报告会话
   *  状态、响应结束时也没有后台任务的旧版 CLI 保持一次性——只经 done 上报、
   *  没有 turn_complete。`done` / `error` 才是整个运行（含后台任务与
   *  自动续答）的终态。宿主 UI 只打断当前 Claude 回复时（CC GUI 里后台任务
   *  运行期间的 Stop；进程与后台任务继续存活），被打断的响应在 CLI 确认后
   *  以 `turn_complete` 结束，`data` 为 { usage, interrupted: true }（其余
   *  响应缺省 / false）：不是 `error`，也不是终态，运行随后进入
   *  `activity: waiting`（仍有后台任务）或最终的 `done`；其 usage 可能为零
   *  （真实 CLI 对被打断的响应不计用量）。`ctx.agent.interrupt()` 不会产生
   *  该标记：它终止进程树，运行仍以 `done` / `error` 收尾；插件自启的 run
   *  不受宿主 Stop 影响，故本流通常见不到它，流原样透传、不剥离。
   *  另有仅供展示的 `tasks`（data { tasks: [{ id, kind,
   *  description, status, toolUseId?, summary?, progress?, background?,
   *  ambient? }] }，全量原生任务目录快照）与 `activity`（data { state:
   *  running | requires_action | waiting }，永不是终态；`waiting` 表示主回复
   *  已结束而后台任务仍在、主线程可接收新消息——后台子代理仍在忙时 CLI 自身会
   *  一直报「运行中」，不影响它，`running` 只表示主线程正在回复）。桌面专属。 */
  agent: {
    catalog(workspacePath: string): Promise<PluginAgentCatalogEntry[]>;
    start(def: {
      engine: string;
      prompt: string;
      workspacePath: string;
      model?: string;
      providerId?: string;
      sessionId?: string;
      readOnly?: boolean;
      requestId?: string;
    }): Promise<{ runId: string; sessionId: string | null }>;
    interrupt(runId: string): Promise<boolean>;
  };
  bridge: {
    /** 通用能力出口（0.3.0 起；旧的 `cmd:<command>` 逐命令授权机制已删除）。
     *  仅四条命令，`pluginId` 由宿主自动注入（插件无需也不能传）：
     *
     *  - `plugin_http_request` `{ method, url, headers?, body? }` →
     *    `{ status, body }`：url 限 http/https，host(+端口) 须命中 manifest 的
     *    `network:<host>` / `network:<host>:<port>` / `network:<host>:<a>-<b>` 授权
     *    （形状与放行规则以 spec/permissions.json 为准）。
     *  - `plugin_exec_run` `{ bin, args, env?, timeoutMs? }` →
     *    `{ code, stdout, stderr }`：bin 须命中 `exec:<bin>` 授权（裸名，无路径）。
     *  - `plugin_exec_spawn` `{ bin, args, env?, lifecycle? }` → void：
     *    同授权；成功时 resolve 为 void（Rust 返回 ()），失败 reject。
     *    lifecycle 缺省 "detached"（用户级服务，活过插件）；"plugin" =
     *    附属进程，宿主跟踪，插件禁用/卸载时自动 kill。
     *  - `plugin_exec_kill` `{}` → `{ killed: number }`：kill 本插件全部
     *    lifecycle="plugin" 子进程（配置变更改名重启用；需任意 exec: 授权）。
     *
     *  授权未命中的调用在 JS 侧即 reject（不打 IPC）；Rust 侧对授权与插件
     *  启用态另有强制（纵深防御）。 */
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
  host: {
    /** SDK 0.3.18: await restored runtime ownership before plugin I/O.
     * Register UI/chat owners synchronously first; signal cancels an unload wait. */
    whenReady(signal?: AbortSignal): Promise<void>;
    appVersion: string;
    /** 宿主实现的 SDK 版本（= @ccgui/plugin-sdk version）。 */
    sdkVersion: string;
    locale: string;
    /** Web 客户端为 true；上述桌面独占桥命令在那里不可用。 */
    isWeb: boolean;
  };
}
