import { createRoot } from "react-dom/client";
import type { HandoffCompressionSelection } from "@/lib/ipc";
import { HandoffModelPickerDialog } from "./components/HandoffModelPickerDialog";

export interface ChooseHandoffModelOptions {
  workspacePath: string;
  selection: HandoffCompressionSelection;
}

let active = false;

/** Shows the host picker without persisting preferences or starting a model call.
 * Concurrent callers fail explicitly so one task cannot receive another's selection. */
export function chooseHandoffModel({ workspacePath, selection }: ChooseHandoffModelOptions): Promise<HandoffCompressionSelection | null> {
  if (active) return Promise.reject(new Error("HANDOFF_MODEL_PICKER_BUSY"));
  active = true;
  const container = document.createElement("div");
  container.dataset.handoffModelPickerRoot = "";
  document.body.appendChild(container);
  const root = createRoot(container);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      try { root.unmount(); } finally { container.remove(); active = false; }
    };
    const close = (result: HandoffCompressionSelection | null) => {
      if (settled) return;
      settled = true;
      // Unmount outside React's event/effect stack, before notifying the caller.
      queueMicrotask(() => { cleanup(); resolve(result); });
    };
    try {
      root.render(<HandoffModelPickerDialog workspacePath={workspacePath} selection={{ ...selection }} onClose={close} />);
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
    }
  });
}
