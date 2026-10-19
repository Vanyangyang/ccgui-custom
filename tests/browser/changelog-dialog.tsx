// Open /tests/browser/changelog-dialog.html with the Vite dev server running.
// Layout smoke for the version-history dialog (Settings → About → 版本记录):
// the body must actually scroll (ModalShell's inner Dialog passes the flex
// height constraint through), the footer pager must stay inside the modal,
// and paging must reach the oldest entry (v1.0.0). No app, no backend.
import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

localStorage.setItem("ccgui-next.language", "zh");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(reason: string): never {
  throw new Error(reason);
}

async function main() {
  // Dynamic imports: localStorage language above must land before the i18n
  // module's top-level side effects run; static imports would hoist.
  await import("../../src/lib/i18n");
  const [{ ChangelogDialog }, { CHANGELOG_DATA, GITHUB_REPO_URL }] = await Promise.all([
    import("../../src/features/settings/ChangelogDialog"),
    import("../../src/version/changelog"),
  ]);

  createRoot(document.getElementById("fixture")!).render(
    <ChangelogDialog entries={CHANGELOG_DATA} githubUrl={GITHUB_REPO_URL} onClose={() => {}} />,
  );
  await sleep(300);

  const dialog = document.querySelector('[role="dialog"]') ?? fail("dialog missing");
  const modal = dialog.parentElement ?? fail("modal missing");
  const body = modal.querySelector(".overflow-y-auto") ?? fail("scroll body missing");
  const starButtons = [...document.querySelectorAll(`button[aria-label]`)].filter((b) =>
    b.getAttribute("aria-label")?.includes("Star"),
  );
  if (starButtons.length !== 1) fail(`expected 1 Star button in header, got ${starButtons.length}`);
  if (document.body.textContent?.includes("谨防盗版")) fail("open-source banner still rendered");

  const { scrollHeight, clientHeight } = body as HTMLElement;
  if (scrollHeight <= clientHeight)
    fail(`body not scrollable: scrollHeight=${scrollHeight} clientHeight=${clientHeight}`);

  const next = document.querySelector(`button[aria-label="下一个版本"]`) ?? fail("pager missing");
  const pagerRect = next.getBoundingClientRect();
  const modalRect = modal.getBoundingClientRect();
  if (pagerRect.bottom > modalRect.bottom || modalRect.bottom > window.innerHeight)
    fail(
      `pager clipped: pagerBottom=${pagerRect.bottom} modalBottom=${modalRect.bottom} viewport=${window.innerHeight}`,
    );

  // Page to the oldest entry via the footer chevron.
  for (let i = 0; i < CHANGELOG_DATA.length - 1; i++) {
    (next as HTMLButtonElement).click();
    await sleep(50);
  }
  const oldest = CHANGELOG_DATA[CHANGELOG_DATA.length - 1];
  if (!document.body.textContent?.includes(`v${oldest.version}`))
    fail(`paging never reached v${oldest.version}`);

  document.getElementById("result")!.textContent = JSON.stringify({
    status: "PASS",
    scroll: { scrollHeight, clientHeight },
    oldest: oldest.version,
  });
}

main().catch((error) => {
  document.getElementById("result")!.textContent = JSON.stringify({
    status: "FAIL",
    error: String(error),
  });
});
