import Gauge from "lucide-react/dist/esm/icons/gauge";
import GitMerge from "lucide-react/dist/esm/icons/git-merge";
import Route from "lucide-react/dist/esm/icons/route";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check";
import type { ComposerPermissionOption } from "./permission-menu";

/** The four permission modes, in menu order. Auto is the default. */
export const COMPOSER_PERMISSIONS: ComposerPermissionOption[] = [
  {
    id: "auto",
    labelKey: "permissionAuto",
    descriptionKey: "permissionAutoDesc",
    icon: Gauge,
  },
  {
    id: "manual",
    labelKey: "permissionManual",
    descriptionKey: "permissionManualDesc",
    icon: GitMerge,
    flip: true,
  },
  {
    id: "plan",
    labelKey: "permissionPlan",
    descriptionKey: "permissionPlanDesc",
    icon: Route,
    flip: true,
  },
  {
    id: "bypass",
    labelKey: "permissionBypass",
    descriptionKey: "permissionBypassDesc",
    icon: ShieldCheck,
  },
];
