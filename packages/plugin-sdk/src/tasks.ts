/**
 * Host task routing and execution (`host:tasks`, desktop only, 0.3.20).
 * Pure types; the host implements them in src/features/plugins/runtime/task-*.ts.
 *
 * A task is delivered as a real GUI conversation turn: the host reuses the
 * slot's saved chat or creates a background chat in the execution workspace,
 * with the user's own model/permission settings. Workspace registration is
 * not an OS sandbox; write paths are a declared scope used for conflict
 * ordering and told to the executing AI, not enforced on the file system.
 */

import type { HostFixedInstructions } from "./fixed-instructions";

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
  /** 0.3.22: exact launch selection and project-member native child routing. 0.3.23: durable image attachments. */
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

/** Requested or natively resolved launch configuration; not upstream model telemetry. */
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
  /** Requires advertised support and an explicit supported engine. Persisted
   * before launch and restored independently of the model's conversation history. */
  fixedInstructions?: HostFixedInstructions;
  /** User-authored visible text, at most 120000 characters. Fingerprinted and
   * persisted; only projected onto the exactly correlated native user row. */
  displayText?: string;
  /** Declared write scope relative to workspacePath. Omitted = unknown (whole workspace, serialized). [] = read-only. */
  writePaths?: string[];
  /** References the AI should consult on demand (paths, memory ids). Listed, never expanded. */
  contextRefs?: string[];
  /** "auto" reuses the slot's chat when still valid; "new" always starts a chat. */
  sessionMode: "auto" | "new";
  /** Reserve an exclusive coordinator from durable acceptance, before any view
   * attaches. Requires sessionMode: "new". Ordinary task routing is unchanged. */
  coordination?: true;
  /** Adds a bounded handoff note from an earlier task receipt or chat. */
  handoffFrom?: HostTaskHandoff;
  /** Explicit choices must match a reused chat; otherwise a new chat is started. */
  engine?: string;
  model?: string;
  effort?: string;
  /** 0.3.22: exact channel id. Requires explicit engine/model/effort, currently Claude/Codex. */
  providerId?: string;
  /** 0.3.23: up to 8 opaque plugin image attachment IDs owned by this plugin. */
  images?: string[];
}

export type HostTaskStatus = "queued" | "starting" | "executing" | "awaiting_permission" | "completed" | "failed" | "cancelled" | "unknown";

export interface HostTaskReceipt {
  readonly requestedSelection?: HostTaskSelection;
  /** Native launch resolution, not a claim about a remote provider's actual model. */
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

/** The `ctx.tasks` capability group (defined inline on PluginContext for docs). */
export type HostTasksApi = import("./context").PluginContext["tasks"];
