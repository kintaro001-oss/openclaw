import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { useDoctorWorkspace } from "./doctor-contract-api.test-support.js";
import * as state from "./src/dreaming-state.js";
import { resetMemoryCoreDreamingStateForTests } from "./src/test-helpers.js";

const namespaces = [
  state.DREAMING_DAILY_INGESTION_NAMESPACE,
  state.DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  state.DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  state.SHORT_TERM_RECALL_NAMESPACE,
  state.SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
];
const migration = stateMigrations.find((entry) => entry.id === "memory-core-dreams-json-to-sqlite");
if (!migration) {
  throw new Error("Missing dreaming state migration");
}

let workspaceDir = "";
const { fixture, context, params } = useDoctorWorkspace(
  "openclaw-memory-core-dreaming-",
  resetMemoryCoreDreamingStateForTests,
);

beforeEach(() => {
  ({ workspaceDir } = fixture);
  state.configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
});
const openStore = (namespace: string) =>
  context().openPluginStateKeyedStore({ namespace, maxEntries: 50_000 });

const migrationParams = () =>
  params({ agents: { entries: { main: { workspace: workspaceDir } } } });
const detect = () => migration.detectLegacyState(migrationParams());
const migrate = () => migration.migrateLegacyState(migrationParams());
const put = (namespace: string, key: string, value: object, workspace = workspaceDir) =>
  state.writeMemoryCoreWorkspaceEntry({ namespace, key, value, workspaceDir: workspace });

async function writeRetiredDreamingFiles(contents: string) {
  const paths = [
    "daily-ingestion.json",
    "session-ingestion.json",
    "short-term-recall.json",
    "phase-signals.json",
  ].map((name) => path.join(workspaceDir, "memory", ".dreams", name));
  await Promise.all(paths.map((filePath) => fs.writeFile(filePath, contents)));
  return {
    paths,
    async expectUnchanged() {
      for (const filePath of paths) {
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe(contents);
        await expect(fs.access(`${filePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  };
}

async function expectNoMigration() {
  await expect(detect()).resolves.toBeNull();
  await expect(migrate()).resolves.toEqual({ changes: [], warnings: [] });
}

it("refuses pre-July dreaming JSON without importing or archiving it", async () => {
  const retired = await writeRetiredDreamingFiles('{"version":1}\n');
  await put(
    state.DREAMING_DAILY_INGESTION_NAMESPACE,
    "memory/2026-07-01.md",
    { mtimeMs: 1, size: 42 },
    path.join(fixture.rootDir, "another-workspace"),
  );
  const result = await migrate();
  expect(result).toEqual({
    changes: [],
    warnings: retired.paths.map((filePath) =>
      expect.stringContaining(`no longer migrated (${filePath})`),
    ),
  });
  await expect(detect()).resolves.toEqual({
    preview: result.warnings.map((warning) => `- ${warning}`),
  });
  await retired.expectUnchanged();
  for (const namespace of namespaces) {
    expect(await state.readMemoryCoreWorkspaceEntries({ namespace, workspaceDir })).toEqual([]);
  }
});

it("preserves July keyed dreaming state when retired JSON files remain", async () => {
  const retired = await writeRetiredDreamingFiles("{unread retired JSON");
  // Persist the v2026.7.1-beta.1 envelope independently of today's workspace writer.
  // Doctor checks row presence; payload decoding belongs to the ingestion and promotion suites.
  const normalizedWorkspace = path.resolve(workspaceDir).replace(/\\/g, "/");
  const workspaceKey = createHash("sha256")
    .update(process.platform === "win32" ? normalizedWorkspace.toLowerCase() : normalizedWorkspace)
    .digest("hex");
  const stores = [];
  for (const namespace of namespaces) {
    const store = openStore(namespace);
    await store.register(
      `${workspaceKey}:${createHash("sha256").update(namespace).digest("hex")}`,
      {
        version: 1,
        workspaceKey,
        workspaceDir: path.resolve(workspaceDir),
        key: namespace,
        value: { checkpoint: namespace },
      },
    );
    stores.push(store);
  }
  const before = await Promise.all(stores.map((store) => store.entries()));
  await expectNoMigration();
  expect(await Promise.all(stores.map((store) => store.entries()))).toEqual(before);
  await retired.expectUnchanged();
  for (const namespace of namespaces) {
    expect(await state.readMemoryCoreWorkspaceEntries({ namespace, workspaceDir })).toEqual([
      { key: namespace, value: { checkpoint: namespace } },
    ]);
  }
});

it("recognizes empty canonical stores only when their existing markers distinguish them", async () => {
  const retired = await writeRetiredDreamingFiles("{retained rollback bytes");
  for (const key of ["recall", "phase"]) {
    await put(state.SHORT_TERM_META_NAMESPACE, key, { updatedAt: "2026-07-01T12:00:00.000Z" });
  }
  const acknowledgementNamespace = "legacy-dreaming-source-acknowledgements";
  for (const label of ["daily ingestion", "session ingestion"]) {
    await put(acknowledgementNamespace, `legacy-source:${label}`, { sha256: "a".repeat(64) });
  }
  const acknowledgements = openStore(acknowledgementNamespace);
  const before = await acknowledgements.entries();
  await expectNoMigration();
  expect(await acknowledgements.entries()).toEqual(before);
  await acknowledgements.clear();
  const ambiguous = await migrate();
  expect(ambiguous).toEqual({
    changes: [],
    warnings: [
      expect.stringContaining("Memory Core daily ingestion"),
      expect.stringContaining("Memory Core session ingestion"),
    ],
  });
  expect(ambiguous.warnings[0]).toContain("an empty ingestion store cannot be distinguished");
  expect(await acknowledgements.entries()).toEqual([]);
  await retired.expectUnchanged();
});
