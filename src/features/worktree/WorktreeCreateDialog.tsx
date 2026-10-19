import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "@/components/dialogs";
import { Button } from "@/components/base/buttons/button";
import { Chip } from "@/components/base/chips/chip";
import { Input } from "@/components/base/input/input";
import { Switch } from "@/components/base/switch/switch";
import {
  ipc,
  type PrPreview,
  type Workspace,
  type WorktreeCreateArgs,
} from "@/lib/ipc";
import { useGitStore } from "@/features/git/store";
import { useWorktreeStore } from "./store";
import {
  defaultBaseRef,
  defaultWorktreePath,
  isPlausibleBranchName,
  parsePrInput,
  suggestPrBranch,
} from "./pr-input";
import {
  ExistingBranchFields,
  NewBranchFields,
  PrSourceFields,
} from "./WorktreeCreateFields";

type SourceTab = "pr" | "new" | "existing";

/** PR fetch state for the PR tab: debounced resolve, with a second pass once
 *  the title arrives (branch name gains the slug). The key guard stops the
 *  loop when the suggestion stabilizes. */
function usePrPreview({
  tab,
  prNumber,
  prInput,
  location,
  locationTouched,
  parentPath,
}: {
  tab: SourceTab;
  prNumber: number | null;
  prInput: string;
  location: string;
  locationTouched: boolean;
  parentPath: string;
}) {
  const [preview, setPreview] = useState<PrPreview | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<"notGitHub" | "invalidPrInput" | null>(null);
  const resolveSeq = useRef(0);
  const lastResolveKey = useRef("");
  useEffect(() => {
    if (tab !== "pr") return;
    if (!prNumber) {
      setPreview(null);
      setResolveError(null);
      setResolving(false);
      lastResolveKey.current = "";
      return;
    }
    const seq = ++resolveSeq.current;
    setResolving(true);
    setResolveError(null);
    const timer = setTimeout(() => {
      // preview?.title 参与派生分支名，必须跟踪；title 晚到时再跑一轮。
      const suggested = suggestPrBranch(prNumber, preview?.title);
      const dir = locationTouched
        ? location.trim()
        : defaultWorktreePath(parentPath, suggested);
      const key = `${prNumber}|${suggested}|${dir}`;
      if (lastResolveKey.current === key) {
        setResolving(false);
        return;
      }
      lastResolveKey.current = key;
      void ipc
        .gitResolvePr(parentPath, prInput, suggested, dir)
        .then((p) => {
          if (resolveSeq.current !== seq) return;
          setPreview(p);
          setResolving(false);
        })
        .catch((err) => {
          if (resolveSeq.current !== seq) return;
          setPreview(null);
          setResolving(false);
          setResolveError(String(err).includes("not_github") ? "notGitHub" : "invalidPrInput");
        });
    }, 400);
    return () => clearTimeout(timer);
    // 依赖 preview?.title：标题晚到时重跑并复查冲突；key guard 防死循环。
  }, [prInput, prNumber, preview?.title, location, locationTouched, parentPath, tab]);

  const suggestedBranch = prNumber ? suggestPrBranch(prNumber, preview?.title) : "";
  return { preview, resolving, resolveError, suggestedBranch };
}

interface CreateSubmitState {
  submitting: boolean;
  effectiveBranch: string;
  location: string;
  tab: SourceTab;
  prNumber: number | null;
  preview: PrPreview | null;
  resolving: boolean;
  newBranchInvalid: boolean;
  newBranchClash: boolean;
  base: string | null;
  existing: string | null;
  occupied: Set<string>;
}

/** Whether the current tab's pick is complete enough to submit. */
function canSubmitCreate(state: CreateSubmitState): boolean {
  if (state.submitting) return false;
  if (state.effectiveBranch === "" || state.location.trim() === "") return false;
  if (state.tab === "pr") {
    return (
      state.prNumber != null &&
      state.preview != null &&
      !state.resolving &&
      !state.preview.branchConflict &&
      !state.preview.dirConflict
    );
  }
  if (state.tab === "new") {
    return !state.newBranchInvalid && !state.newBranchClash && state.base != null;
  }
  return state.existing != null && !state.occupied.has(state.existing);
}

/** Background-pipeline arguments assembled from the current form state. */
function buildCreateArgs({
  parent,
  tab,
  effectiveBranch,
  location,
  base,
  prNumber,
  preview,
  prInput,
}: {
  parent: Workspace;
  tab: SourceTab;
  effectiveBranch: string;
  location: string;
  base: string | null;
  prNumber: number | null;
  preview: PrPreview | null;
  prInput: string;
}): WorktreeCreateArgs {
  return {
    repoPath: parent.path,
    parentWorkspaceId: parent.id,
    branch: effectiveBranch,
    worktreePath: location.trim(),
    baseRef: tab === "new" ? base : null,
    prNumber: tab === "pr" ? prNumber : null,
    prTitle: tab === "pr" ? (preview?.title ?? null) : null,
    prUrl:
      tab === "pr" && prNumber
        ? prInput.includes("github.com")
          ? prInput.trim()
          : `https://github.com/${preview?.repo}/pull/${prNumber}`
        : null,
    existingBranch: tab === "existing",
  };
}

/** Worktree-create form state, derived values, and submit. Kept JSX-free so
 *  the dialog below only composes its tabs and field groups. */
function useWorktreeCreateForm(parent: Workspace, onClose: () => void) {
  const prefs = useWorktreeStore((s) => s.prefs);
  const branches = useGitStore((s) => s.branchesByWorkspace[parent.path]);
  /** 当前检出分支，跟实时 status（同 useBranchSwitcher）；detached HEAD 是 "HEAD"。 */
  const currentBranch = useGitStore((s) => s.statusByWorkspace[parent.path]?.branch);

  const [tab, setTab] = useState<SourceTab>("new");
  const [occupied, setOccupied] = useState<Set<string>>(new Set());

  // PR tab
  const [prInput, setPrInput] = useState("");

  // New-branch tab
  const [branchName, setBranchName] = useState("");
  // null = 用户没手选过，base 用下面派生的默认值。
  const [pickedBase, setPickedBase] = useState<string | null>(null);

  // Existing-branch tab
  const [existing, setExisting] = useState<string | null>(null);

  // Shared
  const [location, setLocation] = useState(prefs.location ?? "");
  const [locationTouched, setLocationTouched] = useState(prefs.location != null);
  const [openSessionAfter, setOpenSessionAfter] = useState(prefs.openSessionAfter);
  const [submitting, setSubmitting] = useState(false);

  const prNumber = tab === "pr" ? parsePrInput(prInput) : null;
  const { preview, resolving, resolveError, suggestedBranch } = usePrPreview({
    tab,
    prNumber,
    prInput,
    location,
    locationTouched,
    parentPath: parent.path,
  });

  // Branch list + occupancy (existing-branch flow blocks checked-out names).
  useEffect(() => {
    const git = useGitStore.getState();
    void git.loadBranches(parent.path);
    // 默认 base 取自当前分支，status 也要拉（30s TTL / 在途去重在 git store）。
    void git.refresh(parent.path).catch(() => undefined);
    void ipc
      .gitWorktreeList(parent.path)
      .then((list) => {
        setOccupied(
          new Set(list.map((w) => w.branch).filter((b): b is string => b != null)),
        );
      })
      .catch(() => undefined);
  }, [parent.path]);

  // Default base: 当前分支（main/master 除外，规则与理由见 defaultBaseRef）。
  // 派生而非写进 state：status 比分支列表晚到时默认值能自己跟上，用户手选过则不再改。
  const defaultBase = useMemo(
    () => defaultBaseRef(branches ?? [], currentBranch),
    [branches, currentBranch],
  );
  const base = pickedBase ?? defaultBase;
  const effectiveBranch =
    tab === "pr"
      ? suggestedBranch
      : tab === "new"
        ? branchName.trim()
        : (existing ?? "");

  // Location follows the branch name until the user edits it manually.
  useEffect(() => {
    if (locationTouched) return;
    setLocation(effectiveBranch ? defaultWorktreePath(parent.path, effectiveBranch) : "");
  }, [effectiveBranch, locationTouched, parent.path]);

  const localBranchNames = useMemo(
    () => new Set((branches ?? []).filter((b) => !b.isRemote).map((b) => b.name)),
    [branches],
  );

  const newBranchInvalid =
    tab === "new" && branchName.trim() !== "" && !isPlausibleBranchName(branchName.trim());
  const newBranchClash = tab === "new" && localBranchNames.has(branchName.trim());

  const canSubmit = canSubmitCreate({
    submitting,
    effectiveBranch,
    location,
    tab,
    prNumber,
    preview,
    resolving,
    newBranchInvalid,
    newBranchClash,
    base,
    existing,
    occupied,
  });

  const submit = () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    const store = useWorktreeStore.getState();
    store.setPrefs({
      location: locationTouched ? location.trim() : null,
      openSessionAfter,
    });
    store.start(
      buildCreateArgs({
        parent,
        tab,
        effectiveBranch,
        location,
        base,
        prNumber,
        preview,
        prInput,
      }),
      { parentPath: parent.path, openSessionAfter },
    );
    onClose();
  };

  const onLocationChange = (value: string) => {
    setLocation(value);
    setLocationTouched(true);
  };

  return {
    tab,
    setTab,
    prInput,
    setPrInput,
    prNumber,
    preview,
    resolving,
    resolveError,
    branchName,
    setBranchName,
    newBranchInvalid,
    newBranchClash,
    base,
    setPickedBase,
    branches: branches ?? [],
    occupied,
    existing,
    setExisting,
    location,
    onLocationChange,
    openSessionAfter,
    setOpenSessionAfter,
    canSubmit,
    submit,
    effectiveBranch,
  };
}

/** Three-source worktree creation (new branch / existing branch / PR). The
 *  submit hands off to the background pipeline immediately — progress lives
 *  in the sidebar's pending row, so the dialog closes on submit. */
export function WorktreeCreateDialog({
  parent,
  onClose,
}: {
  parent: Workspace;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const form = useWorktreeCreateForm(parent, onClose);

  return (
    <ModalShell label={t("worktree.createTitle")} onClose={onClose} className="w-[28rem]">
      <div
        className="flex flex-col gap-3"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            form.submit();
          }
        }}
      >
        <div>
          <h3 className="text-title-3-semibold text-text-primary">{t("worktree.createTitle")}</h3>
          <div className="mt-0.5 text-caption-1-regular text-text-tertiary">
            {t("worktree.createBasedOn", { name: parent.name })}
          </div>
        </div>

        <div className="flex gap-1.5">
          <Chip selected={form.tab === "new"} onClick={() => form.setTab("new")}>
            {t("worktree.tabNewBranch")}
          </Chip>
          <Chip selected={form.tab === "existing"} onClick={() => form.setTab("existing")}>
            {t("worktree.tabExistingBranch")}
          </Chip>
          <Chip selected={form.tab === "pr"} onClick={() => form.setTab("pr")}>
            {t("worktree.tabFromPr")}
          </Chip>
        </div>

        {form.tab === "pr" && (
          <PrSourceFields
            prInput={form.prInput}
            prNumber={form.prNumber}
            preview={form.preview}
            resolving={form.resolving}
            resolveError={form.resolveError}
            effectiveBranch={form.effectiveBranch}
            base={form.base}
            onPrInputChange={form.setPrInput}
          />
        )}

        {form.tab === "new" && (
          <NewBranchFields
            branchName={form.branchName}
            invalid={form.newBranchInvalid}
            clash={form.newBranchClash}
            base={form.base}
            branches={form.branches}
            onBranchNameChange={form.setBranchName}
            onBaseSelect={form.setPickedBase}
          />
        )}

        {form.tab === "existing" && (
          <ExistingBranchFields
            existing={form.existing}
            branches={form.branches}
            occupied={form.occupied}
            onExistingSelect={form.setExisting}
          />
        )}

        <Input
          size="small"
          label={t("worktree.locationLabel")}
          hint={t("worktree.locationHint")}
          value={form.location}
          onChange={form.onLocationChange}
        />

        <Switch
          size="sm"
          isSelected={form.openSessionAfter}
          onChange={form.setOpenSessionAfter}
        >
          {t("worktree.openSessionAfter")}
        </Switch>

        <div className="mt-1 flex justify-end gap-2 border-t border-separator-border pt-3">
          <Button variant="secondary" size="small" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="small" disabled={!form.canSubmit} onClick={form.submit}>
            {t("worktree.createSubmit")}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
