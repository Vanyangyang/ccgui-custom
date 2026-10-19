// Open /tests/browser/usage-pane.html with the Vite dev server running.
// Renders the real UsageSection inside the settings modal's content pane with
// a mocked IPC surface, so one model that the ledger recorded twice (relay
// slug + plain id) can be checked for a single merged row, live refresh, the
// per-day chart tooltip, and the axis tooltip that totals the selected range
// (轴区悬停 → 今日/本周/本月 的区间合计). No app, no database, no saved state.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { UsageSection } from "../../src/features/settings/UsageSection";

function Fixture() {
  return (
    <div className="mx-auto mt-8">
      <div className="flex h-[720px] w-[1120px] flex-col overflow-clip rounded-3xl bg-background-full">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div id="pane" className="h-full overflow-y-auto px-8 pb-8 pt-8">
            {/* Same reading column as SettingsShell's content pane. */}
            <div className="mx-auto w-full max-w-[720px]">
              <UsageSection />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("fixture")!).render(<Fixture />);
