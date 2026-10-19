import { describe, expect, it } from "vitest";
import type { Message } from "@/lib/ipc";
import { deriveAgentTaskSteps, deriveNativeTaskSteps, deriveTodoList, subagentRefsFromArgs } from "./agent-task-steps";

function tool(seq: number, text: string, args?: unknown, result?: unknown): Message {
  return { seq, role: "tool", text, ts: null, args, result } as Message;
}

/** The shapes omp actually writes into the session transcript. */
const DISPATCH = tool(2, "task · Dispatching parallel agents", {
  context: "# Goal ...",
  tasks: [
    { agent: "task", name: "CoreInvokeFilterParse", task: "# Target\n只改一个文件…" },
    { agent: "task", name: "IdolLiveDemosaic", task: "# Target\nIdolLive 复验…" },
    { agent: "task", name: "IdolLiveTranslate", task: "# Target\n翻译复验…" },
  ],
});
const WAIT = tool(3, "hub · Waiting for the four concurrent subagents", { i: "…", op: "wait", timeoutMs: 600000 });
const WAIT_BY_ID = tool(4, "hub · Waiting for CoreInvokeFilterParse", { i: "…", ids: ["CoreInvokeFilterParse"], op: "wait" });
/** A wait that also covers a background job id the dispatch did not name. */
const WAIT_EXTRA = tool(5, "hub · Waiting on the queue", { i: "…", ids: ["bg_4"], op: "wait" });

describe("subagent counting", () => {
  it("retains the exact native task id separately from its display key and label", () => {
    const [step] = deriveNativeTaskSteps([
      { id: "task:real/id", kind: "local_bash", description: "find /workspace", status: "running" },
    ], "run:real/id");
    expect(step).toMatchObject({
      key: "native:run:real/id:task:real/id",
      nativeTaskId: "task:real/id",
      label: "find /workspace",
      nativeStatus: "running",
    });
    expect(deriveAgentTaskSteps([tool(1, "Agent", { description: "task:real/id" })], true, "claude")[0].nativeTaskId).toBeUndefined();
  });
  it.each([
    { backgroundTaskId: "background-1" },
    { isAsync: true },
    { status: "async_launched" },
    JSON.stringify({ backgroundTaskId: "background-1" }),
    { details: { status: "async_launched" } },
  ])("does not infer success for a persisted Claude async launch receipt %j", (receipt) => {
    const messages: Message[] = [
      tool(1, "Agent", { description: "Background review" }, receipt),
      { seq: 2, role: "assistant", text: "Review started", ts: null },
    ];
    expect(deriveAgentTaskSteps(messages, false, "claude")[0].nativeStatus).toBe("unknown");
    expect(deriveAgentTaskSteps(messages, true, "claude")[0].nativeStatus).toBe("unknown");
    expect(deriveAgentTaskSteps(messages, false, "omp")[0].nativeStatus).toBeUndefined();
  });

  // The history loader keeps only the tool_result content for Claude
  // transcripts (the structured toolUseResult sibling is dropped), so a
  // reopened tab sees the receipt text, never the structured fields.
  const RECEIPT =
    "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n" +
    "agentId: a7e517f7a4430465b (internal ID - do not mention to user.)\n" +
    "The agent is working in the background. You will be notified automatically when it completes.";

  it.each([
    ["an array of text blocks", [{ type: "text", text: RECEIPT }]],
    ["a plain string", RECEIPT],
    ["a JSON-encoded array of text blocks", JSON.stringify([{ type: "text", text: RECEIPT }])],
  ])("does not infer success from the async launch receipt text in history (%s)", (_shape, receipt) => {
    const messages: Message[] = [
      tool(1, "Agent", { description: "Background review" }, receipt),
      { seq: 2, role: "assistant", text: "Review started", ts: null },
    ];
    for (const streaming of [false, true]) {
      const steps = deriveAgentTaskSteps(messages, streaming, "claude");
      expect(steps).toHaveLength(1);
      expect(steps[0].nativeStatus).toBe("unknown");
      expect(steps[0].state).toBe("complete");
    }
    expect(deriveAgentTaskSteps(messages, false, "omp")[0].nativeStatus).toBeUndefined();
  });

  // Real transcript shape: the Workflow tool_result content is a plain string
  // that leads with the launch sentence, then "Task ID" and a summary.
  const WORKFLOW_RECEIPT =
    "Workflow launched in background. Task ID: wb8uelvyk\n" +
    "Summary: Independent multi-lens review of the uncommitted diff\n" +
    "Transcript dir: C:\\Users\\me\\.claude\\projects\\x\\subagents\\workflows\\wf_1";
  const workflowTurn = (result: unknown): Message[] => [
    tool(1, "Workflow", { script: "export const meta = { name: 'review' }" }, result),
    { seq: 2, role: "assistant", text: "Workflow started", ts: null },
  ];

  it.each([
    ["a plain string", WORKFLOW_RECEIPT],
    ["a plain string with leading whitespace", `\n  ${WORKFLOW_RECEIPT}`],
    ["an array of text blocks", [{ type: "text", text: WORKFLOW_RECEIPT }]],
    ["a JSON-encoded array of text blocks", JSON.stringify([{ type: "text", text: WORKFLOW_RECEIPT }])],
  ])("does not infer success from a background Workflow launch receipt in history (%s)", (_shape, receipt) => {
    for (const streaming of [false, true]) {
      const steps = deriveAgentTaskSteps(workflowTurn(receipt), streaming, "claude");
      expect(steps).toHaveLength(1);
      expect(steps[0].nativeStatus).toBe("unknown");
      expect(steps[0].state).toBe("complete");
    }
    expect(deriveAgentTaskSteps(workflowTurn(receipt), false, "omp")[0].nativeStatus).toBeUndefined();
  });

  it("does not mistake a Workflow result that merely quotes the launch phrase for a launch", () => {
    for (const result of [
      "The run printed: Workflow launched in background. Task ID: abc",
      [{ type: "text", text: "Summary: Workflow launched in background earlier, now finished." }],
      "Workflow finished: 4 agents completed.",
    ]) {
      expect(deriveAgentTaskSteps(workflowTurn(result), false, "claude")[0].nativeStatus).toBeUndefined();
    }
  });

  it("still completes an ordinary Claude agent whose result is a text-block array", () => {
    const steps = deriveAgentTaskSteps([
      tool(1, "Agent", { description: "Review" }, [{ type: "text", text: "Found 3 issues in the diff." }]),
      { seq: 2, role: "assistant", text: "Done", ts: null },
    ], false, "claude");
    expect(steps[0].state).toBe("complete");
    expect(steps[0].nativeStatus).toBeUndefined();
  });

  it("does not mistake a synchronous result that merely quotes the receipt phrase for a launch", () => {
    const steps = deriveAgentTaskSteps([
      tool(1, "Agent", { description: "Docs" }, [{ type: "text", text: "The tool printed: Async agent launched successfully." }]),
      { seq: 2, role: "assistant", text: "Done", ts: null },
    ], false, "claude");
    expect(steps[0].nativeStatus).toBeUndefined();
  });

  it("keeps synchronous Claude agents using the legacy completion evidence", () => {
    const steps = deriveAgentTaskSteps([tool(1, "Agent", { description: "Review" }, { isAsync: false, status: "completed" })], false, "claude");
    expect(steps[0].state).toBe("complete");
    expect(steps[0].nativeStatus).toBeUndefined();
  });

  it("counts the agents a call names, not the call", () => {
    const steps = deriveAgentTaskSteps([DISPATCH], true, "omp");
    expect(steps.map((s) => s.label)).toEqual([
      "CoreInvokeFilterParse",
      "IdolLiveDemosaic",
      "IdolLiveTranslate",
    ]);
    expect(steps.every((s) => s.state === "active")).toBe(true);
  });

  it("does not promote background jobs to subagents", () => {
    const steps = deriveAgentTaskSteps([DISPATCH, WAIT_EXTRA], true, "omp");
    expect(steps.map((s) => s.key)).toEqual([
      "2:CoreInvokeFilterParse",
      "2:IdolLiveDemosaic",
      "2:IdolLiveTranslate",
    ]);
  });

  it("does not double count a wait on ids a dispatch already named", () => {
    const steps = deriveAgentTaskSteps([DISPATCH, WAIT_BY_ID], true, "omp");
    expect(steps).toHaveLength(3);

    const settled = deriveAgentTaskSteps([DISPATCH, WAIT_BY_ID], false, "omp");
    expect(settled.filter((s) => s.state === "complete")).toHaveLength(3);
  });

  it("ignores a call that names no subagent", () => {
    // Roster checks (`hub jobs`) and prose-only waits must not inflate the
    // count — they say nothing about how many agents are out there.
    expect(deriveAgentTaskSteps([WAIT], true, "omp")).toHaveLength(0);
    expect(deriveAgentTaskSteps([tool(2, "hub · Checking background job roster", { op: "jobs" })], true, "omp")).toHaveLength(0);
  });

  it("keeps agents named by a running hub snapshot active even when the host is not streaming", () => {
    const snapshot = tool(6, "hub · Waiting for workers", { op: "wait" }, {
      details: {
        op: "wait",
        jobs: [
          { id: "CoreInvokeFilterParse", type: "task", status: "running" },
          { id: "IdolLiveTranslate", type: "task", status: "running" },
        ],
      },
    });
    const steps = deriveAgentTaskSteps([DISPATCH, snapshot], false, "omp");
    expect(steps.map(({ label, state }) => ({ label, state }))).toEqual([
      { label: "CoreInvokeFilterParse", state: "active" },
      { label: "IdolLiveDemosaic", state: "complete" },
      { label: "IdolLiveTranslate", state: "active" },
    ]);
  });

  it("retains the complete delegated task as its clickable detail", () => {
    const dispatch = tool(2, "task · Dispatching worker", {
      tasks: [{
        agent: "task",
        name: "Worker",
        task: "# Target\nOwn relay.rs only.\n# Acceptance\nOutages recover without toggling.",
      }],
    });
    expect(deriveAgentTaskSteps([dispatch], true, "omp")[0].detail).toBe(
      "# Target\nOwn relay.rs only.\n# Acceptance\nOutages recover without toggling.",
    );
  });

  it("tags every row: the agent kind when the harness names one, else the tool", () => {
    // The harness writes `agent` only for some dispatches (scout batches carry
    // it, task batches do not); a row without a tag loses the only hint of
    // where it came from.
    const kindless = tool(2, "task · Dispatching workers", {
      tasks: [{ name: "RelayWorker", task: "# Target\nOwn relay.rs." }],
    });
    const kinded = tool(3, "task · Dispatching scouts", {
      tasks: [{ agent: "scout", name: "RepoMap", task: "# Target\nMap the repo." }],
    });
    expect(deriveAgentTaskSteps([kindless, kinded], true, "omp").map((s) => s.subagentType)).toEqual([
      "task",
      "scout",
    ]);
  });

  it("normalizes stringified task arrays before later hub references", () => {
    const encodedDispatch = tool(2, "task · Marking dual-arch regression done", {
      tasks: JSON.stringify([
        { name: "IdolLiveBackstage", task: "# Target\nVerify IdolLive." },
        { name: "AfterstoryCgScene", task: "# Target\nVerify Afterstory." },
      ]),
    });
    const wait = tool(3, "hub · Waiting for live demosaic subagents", {
      ids: ["IdolLiveBackstage", "AfterstoryCgScene"],
      op: "wait",
    });

    expect(
      deriveAgentTaskSteps([encodedDispatch, wait], true, "omp").map(
        ({ label, subagentType }) => ({ label, subagentType }),
      ),
    ).toEqual([
      { label: "IdolLiveBackstage", subagentType: "task" },
      { label: "AfterstoryCgScene", subagentType: "task" },
    ]);
  });

  it("ignores malformed task arrays instead of rendering the dispatch as an agent", () => {
    const malformed = tool(2, "task · Dispatching demosaic evidence tasks", {
      tasks: '[{"name":"IdolLiveSceneDemosaic","task":"unterminated}]',
    });
    const retry = tool(3, "task · Dispatching demosaic evidence tasks", {
      tasks: [
        { name: "IdolLiveSceneDemosaic", task: "# Target\nVerify IdolLive." },
        { name: "AfterstoryMosaicScene", task: "# Target\nVerify Afterstory." },
      ],
    });

    expect(
      deriveAgentTaskSteps([malformed, retry], true, "omp").map(
        ({ label, subagentType }) => ({ label, subagentType }),
      ),
    ).toEqual([
      { label: "IdolLiveSceneDemosaic", subagentType: "task" },
      { label: "AfterstoryMosaicScene", subagentType: "task" },
    ]);
  });

  it("keeps pending and queued dispatch progress active", () => {
    const dispatch = tool(2, "task · Dispatching workers", {
      tasks: [
        { name: "PendingWorker", task: "# Target\nWait for a worker slot." },
        { name: "QueuedWorker", task: "# Target\nWait behind PendingWorker." },
      ],
    }, {
      details: {
        progress: [
          { id: "PendingWorker", status: "pending" },
          { id: "QueuedWorker", status: "queued" },
        ],
      },
    });

    expect(deriveAgentTaskSteps([dispatch], false, "omp").map((step) => step.state)).toEqual([
      "active",
      "active",
    ]);
  });

  it("settles running agents omitted by a later complete jobs roster", () => {
    const running = tool(3, "hub · Waiting for workers", { op: "wait" }, {
      details: {
        op: "wait",
        jobs: [{ id: "CoreInvokeFilterParse", status: "running" }],
      },
    });
    const emptyRoster = tool(4, "hub · Checking background jobs", { op: "jobs" }, {
      details: { op: "jobs", jobs: [] },
    });

    const steps = deriveAgentTaskSteps([DISPATCH, running, emptyRoster], false, "omp");
    expect(steps.every((step) => step.state === "complete")).toBe(true);
  });

  it("does not settle agents from malformed or unknown roster entries", () => {
    const running = tool(3, "hub", { op: "wait" }, {
      details: { jobs: [{ id: "CoreInvokeFilterParse", status: "running" }] },
    });
    const malformed = tool(4, "hub", { op: "jobs" }, {
      details: { op: "jobs", jobs: null },
    });
    const unknown = tool(5, "hub", { op: "jobs" }, {
      details: { op: "jobs", jobs: [{ id: "CoreInvokeFilterParse", status: "unknown" }] },
    });
    expect(deriveAgentTaskSteps([DISPATCH, running, malformed], false, "omp")[0].state).toBe("active");
    expect(deriveAgentTaskSteps([DISPATCH, running, unknown], false, "omp")[0].state).toBe("active");
  });

  it("does not settle agents from a filtered (partial) jobs roster", () => {
    const running = tool(3, "hub", { op: "wait" }, {
      details: { jobs: [{ id: "CoreInvokeFilterParse", status: "running" }] },
    });
    const filtered = tool(4, "hub", { op: "jobs", status: "running" }, {
      details: { op: "jobs", jobs: [] },
    });
    expect(deriveAgentTaskSteps([DISPATCH, running, filtered], false, "omp")[0].state).toBe("active");
  });

  it("reads named agents but ignores background-job ids", () => {
    expect(subagentRefsFromArgs({ ids: ["bg_1", "bg_2"] })).toEqual([]);
    expect(subagentRefsFromArgs({ ids: ["CoreInvokeFilterParse"] })).toEqual([
      { id: "CoreInvokeFilterParse" },
    ]);
    expect(subagentRefsFromArgs({ tasks: [{ id: "alpha" }] })[0]).toMatchObject({ id: "alpha", label: "alpha" });
    expect(subagentRefsFromArgs({ op: "jobs" })).toEqual([]);
  });

  it("resolves a re-spawn's suffixed id back to the dispatch that named it", () => {
    // The reported bug: two review agents, one shown as `reviewer` with its
    // assignment and the other as a bare `hub` with no detail, because the
    // runtime reported it back under a disambiguated id the dispatch's
    // `tasks[]` never spelled out.
    const dispatch = tool(2, "task · Dispatching reviewers", {
      tasks: [
        { agent: "reviewer", name: "HostLifecycleReview", task: "# Target\nReview host lifecycle." },
        { agent: "reviewer", name: "PluginReview", task: "# Target\nReview the plugin surface." },
      ],
    });
    const wait = tool(3, "hub · Waiting for the reviewers", {
      ids: ["HostLifecycleReview", "PluginReview-2"],
      op: "wait",
    });

    expect(
      deriveAgentTaskSteps([dispatch, wait], true, "omp").map(
        ({ label, subagentType, detail }) => ({ label, subagentType, detail }),
      ),
    ).toEqual([
      {
        label: "HostLifecycleReview",
        subagentType: "reviewer",
        detail: "# Target\nReview host lifecycle.",
      },
      // The row keeps the id the runtime reported, and inherits nothing but
      // the kind and the assignment.
      {
        label: "PluginReview-2",
        subagentType: "reviewer",
        detail: "# Target\nReview the plugin surface.",
      },
    ]);
  });

  it("keeps a base name and its suffixed sibling apart when both are live", () => {
    // A suffix only means "same agent, re-spawned" when the base name is gone.
    // Here the wait names both, so two agents really are out there: they stay
    // two rows, and the re-spawn still inherits the kind and assignment of the
    // dispatch its name derives from.
    const dispatch = tool(2, "task · Dispatching a reviewer", {
      tasks: [{ agent: "reviewer", name: "PluginReview", task: "# Target\nReview the plugin surface." }],
    });
    const wait = tool(3, "hub · Waiting for the reviewers", {
      ids: ["PluginReview", "PluginReview-2"],
      op: "wait",
    });

    expect(
      deriveAgentTaskSteps([dispatch, wait], true, "omp").map(
        ({ label, subagentType, detail }) => ({ label, subagentType, detail }),
      ),
    ).toEqual([
      {
        label: "PluginReview",
        subagentType: "reviewer",
        detail: "# Target\nReview the plugin surface.",
      },
      {
        label: "PluginReview-2",
        subagentType: "reviewer",
        detail: "# Target\nReview the plugin surface.",
      },
    ]);
  });

  it("does not let unrelated names inherit each other's assignment", () => {
    // Only a trailing `-<digits>` is a disambiguation suffix. Anything looser
    // would hand one agent's kind and task text to a different agent.
    const dispatch = tool(2, "task · Dispatching a reviewer", {
      tasks: [{ agent: "reviewer", name: "PluginReview", task: "# Target\nReview the plugin surface." }],
    });
    const wait = tool(3, "hub · Waiting for the worker", { ids: ["PluginReviewWorker"], op: "wait" });

    const steps = deriveAgentTaskSteps([dispatch, wait], true, "omp");
    expect(steps.map((s) => s.label)).toEqual(["PluginReview", "PluginReviewWorker"]);
    expect(steps[1].subagentType).toBeUndefined();
    expect(steps[1].detail).toBeUndefined();
  });

  it("leaves a row untagged rather than tagging it with the coordination tool", () => {
    // `hub` is how the host waits on agents, never a kind of agent, so an id
    // no dispatch ever named gets no tag at all.
    const wait = tool(2, "hub · Waiting for a stray worker", { ids: ["StrayWorker"], op: "wait" });
    const steps = deriveAgentTaskSteps([wait], true, "omp");
    expect(steps.map(({ label, subagentType }) => ({ label, subagentType }))).toEqual([
      { label: "StrayWorker", subagentType: undefined },
    ]);
  });

  it("folds authoritative todo snapshot from message.result details.phases", () => {
    const messages: Message[] = [
      tool(1, "todo", { op: "init" }, undefined),
      tool(2, "todo", { op: "done", phase: "verify" }, {
        details: {
          phases: [
            {
              name: "impl",
              tasks: [
                { content: "实现功能", status: "completed" },
              ],
            },
          ],
        },
      }),
    ];
    const items = deriveTodoList(messages);
    expect(items).toEqual([{ content: "实现功能", status: "complete", phase: "impl", reason: undefined, detail: undefined }]);
  });
});
