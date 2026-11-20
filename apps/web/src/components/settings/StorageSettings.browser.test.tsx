import { act, fakeTimers, render, type Screen } from "../../../test/render";
import { RegistryProvider } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type StorageCleanupReport } from "@t3tools/contracts";
import { createContext, type ReactNode, useContext } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  targets: [] as Array<{ environmentId: string; settings: typeof DEFAULT_SERVER_SETTINGS }>,
  run: vi.fn(),
  update: vi.fn(),
  report: null as StorageCleanupReport | null,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const report = Atom.make(() => ({ _tag: "Success", value: state.report, waiting: false }));
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      storageCleanupReport: (() => report) as never,
      runStorageCleanup: {
        ...actual.serverEnvironment.runStorageCleanup,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.run) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    useContext(ScopeRender);
    const environments = state.targets.map(({ environmentId, settings }) => ({
      environmentId,
      label: environmentId,
      serverConfig: {
        settings,
        environment: {
          capabilities: {
            storageCleanup: true,
            storageCleanupRun: true,
            settledWorktreeCleanup: true,
          },
        },
      },
    }));
    return {
      scope: { kind: "all" },
      environments,
      connectedEnvironments: environments,
      targets: state.targets,
      target: null,
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((selector?: (settings: typeof state.settings) => unknown) =>
    selector ? selector(state.settings) : state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: ({ title, description, status, control, children }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {status && (
        <div
          data-testid={`${title === "Delete old browser artifacts" ? "artifact" : "logs"}-retention-status`}
        >
          {status}
        </div>
      )}
      {control}
      {children}
    </div>
  ),
  SettingResetButton: (() => null) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

import { toastManager } from "../ui/toast";
import { StorageCleanupSections } from "./StorageSettings";

function setup() {
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      worktreeKeepWhen: "uncommitted-changes",
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
      settledThreadsAfterDays: null,
      archivedThreadsAfterDays: null,
    },
    projectSettingsOverrides: {},
  };
  state.targets = ["env-a", "env-b"].map((environmentId) => ({
    environmentId,
    settings: state.settings,
  }));
  state.report = null;
  state.run.mockReset();
  state.update.mockReset();
}

function setRetentionValues(
  artifactDays: ReadonlyArray<number | null>,
  logDays: ReadonlyArray<number | null> = artifactDays.map(() => null),
  environmentIds: readonly string[] = ["env-a", "env-b"],
) {
  state.targets = artifactDays.map((browserArtifactsAfterDays, index) => ({
    environmentId: environmentIds[index]!,
    settings: {
      ...state.settings,
      storageCleanup: {
        ...state.settings.storageCleanup,
        browserArtifactsAfterDays,
        logsAfterDays: logDays[index]!,
      },
    },
  }));
  state.settings = state.targets[0]?.settings ?? state.settings;
}

// Each render is a new scope value, as a settings change is in the app, so scope readers re-render.
const ScopeRender = createContext({});
const panel = () => (
  <RegistryProvider>
    <ScopeRender.Provider value={{}}>
      <StorageCleanupSections />
    </ScopeRender.Provider>
  </RegistryProvider>
);
const deleteButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Delete now",
  )!;

it("keeps cleanup disabled when settled retention and all other rules are off", async () => {
  setup();
  await using screen = await render(panel());
  const button = deleteButton(screen.container);

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
});

it("shows a failed thread result from Delete now", async () => {
  setup();
  state.settings = {
    ...state.settings,
    storageCleanup: { ...state.settings.storageCleanup, settledThreadsAfterDays: 30 },
  };
  state.targets = [{ environmentId: "env-a", settings: state.settings }];
  const report: StorageCleanupReport = {
    trigger: "manual",
    startedAt: "2026-11-20T12:00:00.000Z",
    finishedAt: "2026-11-20T12:00:01.000Z",
    entries: [],
    counts: { removed: 0, kept: 0, failed: 0 },
    omittedCount: 0,
    bytesFreed: 0,
    threads: [
      {
        outcome: "failed",
        reason: "database is locked",
        projectPath: null,
        threadId: null,
        threadTitle: null,
      },
    ],
  };
  state.run.mockResolvedValue({ _tag: "Success", value: report });
  vi.mocked(toastManager.add).mockClear();
  await using screen = await render(panel());

  await act(async () => deleteButton(screen.container).click());
  expect(toastManager.add).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Cleanup failed on env-a",
      description: "database is locked",
    }),
  );
});

const rule = "Delete old browser artifacts";
const ruleSwitch = (screen: Screen) => screen.getByRole("switch", { name: rule });
const daysInput = (screen: Screen) => screen.getByLabelText(`${rule} in days`);
const saves = () => state.update.mock.calls.map(([patch]) => patch.storageCleanup);
const failSave = (index: number) => act(() => state.update.mock.calls[index]?.[1]?.onFailed?.());
const withSavedAge = (days: number) => {
  state.settings = {
    ...state.settings,
    storageCleanup: { ...state.settings.storageCleanup, browserArtifactsAfterDays: days },
  };
};

it("saves a newly enabled retention rule only once its age is committed", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  expect(state.update).not.toHaveBeenCalled();
  await expect.element(ruleSwitch(screen)).toBeChecked();
  await expect.element(daysInput(screen)).toHaveFocus();

  await userEvent.fill(daysInput(screen), "30");
  await userEvent.keyboard("{Enter}");
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 30 }]);
  await expect.element(ruleSwitch(screen)).toBeChecked();
});

it("discards a retention draft on Escape, on leaving it untouched, or when switched back off", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(ruleSwitch(screen)).not.toBeChecked();

  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.click(screen.getByRole("heading", { name: rule }));
  await expect.element(ruleSwitch(screen)).not.toBeChecked();

  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "30");
  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).not.toBeInTheDocument();
  await expect.element(ruleSwitch(screen)).not.toBeChecked();
  expect(state.update).not.toHaveBeenCalled();
});

it("saves an edited draft when focus leaves its row, not when it reaches the switch", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "30");
  await userEvent.tab();
  await expect.element(ruleSwitch(screen)).toHaveFocus();
  expect(state.update).not.toHaveBeenCalled();
  await userEvent.tab();
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 30 }]);
});

it("saves a stepped first age only once it is committed", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.click(screen.getByRole("button", { name: `Increase ${rule}` }));
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(daysInput(screen)).toHaveValue("10");
  expect(state.update).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 10 }]);
});

it("does not save the draft age when Enter is pressed on invalid text", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await userEvent.fill(daysInput(screen), "+");
  await userEvent.keyboard("{Enter}");
  expect(state.update).not.toHaveBeenCalled();
});

it("switching an edited saved rule off never saves its age afterwards", async () => {
  setup();
  withSavedAge(30);
  await using screen = await render(panel());
  await userEvent.click(daysInput(screen));
  await userEvent.keyboard("{Control>}a{/Control}40");
  await userEvent.click(ruleSwitch(screen));
  await expect.element(ruleSwitch(screen)).not.toBeChecked();
  await userEvent.click(screen.getByRole("heading", { name: rule }));
  expect(saves()).toEqual([{ browserArtifactsAfterDays: null }]);
});

it("returns a newly enabled retention rule to off when its first save fails", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  await expect.element(daysInput(screen)).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(saves()).toEqual([{ browserArtifactsAfterDays: 8 }]);

  await failSave(0);
  await expect.element(ruleSwitch(screen)).not.toBeChecked();
});

it("keeps a newer pending age open when an older first save fails", async () => {
  setup();
  await using screen = await render(panel());
  await userEvent.click(ruleSwitch(screen));
  for (const age of ["30", "60"]) {
    await userEvent.fill(daysInput(screen), age);
    await userEvent.keyboard("{Enter}");
  }
  expect(saves()).toHaveLength(2);

  await failSave(0);
  await expect.element(daysInput(screen)).toHaveValue("60");
  await expect.element(ruleSwitch(screen)).toBeChecked();
});

it("settles mixed retention statuses independently across selected machines", async () => {
  setup();
  using _timers = fakeTimers();
  await using screen = await render(panel());
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  await advance(300);
  setRetentionValues([8, null], [8, null]);
  await screen.rerender(panel());
  await advance(125);
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
  setRetentionValues([null, null], [8, null]);
  await screen.rerender(panel());
  await advance(8);
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
  await advance(117);
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();

  setRetentionValues([8, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();

  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(75);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([8, null]);
  await screen.rerender(panel());
  await advance(133);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(133);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  await advance(117);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([8, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect
    .element(screen.getByTestId("artifact-retention-status"))
    .toHaveTextContent("Mixed across selected machines");

  setRetentionValues([8], [null], ["env-c"]);
  await screen.rerender(panel());
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();

  setRetentionValues([null, null], [null, null], ["env-c", "env-d"]);
  await screen.rerender(panel());
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();

  setRetentionValues([null, null], [8, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect.element(screen.getByTestId("artifact-retention-status")).not.toBeInTheDocument();
  await expect
    .element(screen.getByTestId("logs-retention-status"))
    .toHaveTextContent("Mixed across selected machines");
  setRetentionValues([null, null]);
  await screen.rerender(panel());
  await advance(300);
  await expect.element(screen.getByTestId("logs-retention-status")).not.toBeInTheDocument();
});
