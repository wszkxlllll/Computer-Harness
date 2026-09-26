import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { environmentLeaseHash, ProcessSharedEnvironmentOwner } from "./environment-owner.js";

const ownerModuleUrl = new URL("./environment-owner.ts", import.meta.url).href;
const childScript = `
const { ProcessSharedEnvironmentOwner } = await import(${JSON.stringify(ownerModuleUrl)});
const [directory, identity, mode, runId] = process.argv.slice(1);
const owner = new ProcessSharedEnvironmentOwner(directory);
try {
  const lease = owner.acquire(identity, runId);
  if (mode === "pending-hold") lease.markPending("fixture outcome requires operator review");
  if (mode === "release") lease.release();
  process.stdout.write("acquired");
} catch (error) {
  process.stdout.write(error instanceof Error ? error.message : String(error));
  process.exitCode = mode === "expect-block" ? 0 : 1;
}
`;

function runOwnerProcess(directory: string, identity: string, mode: "hold" | "pending-hold" | "expect-block" | "release", runId: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childScript, directory, identity, mode, runId], {
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("ProcessSharedEnvironmentOwner", () => {
  it("blocks another process on the same physical desktop and preserves pending_cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-owner-process-"));
    const identity = "cua-local-physical-desktop:test";
    const owner = new ProcessSharedEnvironmentOwner(directory);
    const lease = owner.acquire(identity, "producer-run");
    try {
      const activeConsumer = runOwnerProcess(directory, identity, "expect-block", "consumer-run");
      expect(activeConsumer.error).toBeUndefined();
      expect(activeConsumer.status).toBe(0);
      expect(activeConsumer.stdout).toContain("owned by run producer-run (active)");

      lease.markPending("the action outcome is unknown");
      const pendingConsumer = runOwnerProcess(directory, identity, "expect-block", "consumer-run");
      expect(pendingConsumer.error).toBeUndefined();
      expect(pendingConsumer.status).toBe(0);
      expect(pendingConsumer.stdout).toContain("owned by run producer-run (pending_cleanup)");
      expect(pendingConsumer.stdout).toContain("the action outcome is unknown");
      expect(owner.inspect(identity)?.state).toBe("pending_cleanup");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("converts an abandoned active lease to pending_cleanup without releasing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-owner-orphan-"));
    const identity = "cua-local-physical-desktop:test";
    const owner = new ProcessSharedEnvironmentOwner(directory);
    try {
      const producer = runOwnerProcess(directory, identity, "hold", "abandoned-run");
      expect(producer.error).toBeUndefined();
      expect(producer.status).toBe(0);
      expect(producer.stdout).toBe("acquired");

      expect(owner.inspect(identity)).toMatchObject({ runId: "abandoned-run", state: "pending_cleanup" });
      expect(() => owner.acquire(identity, "must-not-reuse")).toThrow(/pending_cleanup/iu);
      expect(owner.inspect(identity)).toMatchObject({ runId: "abandoned-run", state: "pending_cleanup" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows a new process after a clean owner release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-owner-release-"));
    const identity = "cua-local-physical-desktop:test";
    const owner = new ProcessSharedEnvironmentOwner(directory);
    const lease = owner.acquire(identity, "finished-run");
    try {
      lease.release();
      expect(owner.inspect(identity)).toBeUndefined();
      const consumer = runOwnerProcess(directory, identity, "release", "next-run");
      expect(consumer.error).toBeUndefined();
      expect(consumer.status).toBe(0);
      expect(consumer.stdout).toBe("acquired");
      expect(owner.inspect(identity)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses recovery for a live owner, mismatched identity evidence, or missing inspection attestation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-owner-recovery-refuse-"));
    const identity = "cua-local-physical-desktop:test";
    const owner = new ProcessSharedEnvironmentOwner(directory);
    const lease = owner.acquire(identity, "reviewed-run");
    const baseRequest = {
      identity,
      expectedRunId: "reviewed-run",
      expectedLeaseHash: environmentLeaseHash(identity),
      expectedState: "pending_cleanup" as const,
      operator: "test operator",
      inspectionNote: "Desktop and prior Run evidence were inspected.",
      externalStateInspected: true as const,
    };
    try {
      expect(() => owner.recoverLease(baseRequest)).toThrow(/does not match/iu);
      lease.markPending("waiting for explicit recovery");
      expect(() => owner.recoverLease({ ...baseRequest, expectedRunId: "wrong-run" })).toThrow(/does not match/iu);
      expect(() => owner.recoverLease({ ...baseRequest, expectedLeaseHash: "0".repeat(64) })).toThrow(/expectedLeaseHash/iu);
      expect(() => owner.recoverLease({ ...baseRequest, externalStateInspected: false as unknown as true })).toThrow(/explicitly inspected/iu);
      expect(() => owner.recoverLease(baseRequest)).toThrow(/still alive/iu);
      expect(owner.inspect(identity)).toMatchObject({ runId: "reviewed-run", state: "pending_cleanup" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("quarantines an explicitly reviewed dead pending lease and writes an audit record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-owner-recovery-ok-"));
    const identity = "cua-local-physical-desktop:test";
    const owner = new ProcessSharedEnvironmentOwner(directory);
    try {
      const producer = runOwnerProcess(directory, identity, "pending-hold", "reviewed-run");
      expect(producer.error).toBeUndefined();
      expect(producer.status).toBe(0);
      expect(producer.stdout).toBe("acquired");
      expect(owner.inspect(identity)).toMatchObject({ runId: "reviewed-run", state: "pending_cleanup" });

      const result = owner.recoverLease({
        identity,
        expectedRunId: "reviewed-run",
        expectedLeaseHash: environmentLeaseHash(identity),
        expectedState: "pending_cleanup",
        operator: "fixture reviewer",
        inspectionNote: "Inspected the fixture desktop state and reconciled all prior actions.",
        externalStateInspected: true,
      });
      const quarantined = JSON.parse(await readFile(result.quarantinePath, "utf8")) as { identity: string; runId: string; state: string; token: string };
      const preparedAudit = JSON.parse(await readFile(result.preparedAuditPath, "utf8")) as { status: string; expectedRunId: string };
      const audit = JSON.parse(await readFile(result.auditPath, "utf8")) as { action: string; status: string; identity: string; expectedRunId: string; operator: string; inspectionNote: string; quarantineFile: string; quarantinedAt: string };
      expect(quarantined).toMatchObject({ identity, runId: "reviewed-run", state: "pending_cleanup" });
      expect(quarantined.token.length).toBeGreaterThan(0);
      expect(preparedAudit).toMatchObject({ status: "prepared", expectedRunId: "reviewed-run" });
      expect(audit).toMatchObject({
        action: "quarantine_physical_environment_lease",
        status: "committed",
        identity,
        expectedRunId: "reviewed-run",
        operator: "fixture reviewer",
        inspectionNote: "Inspected the fixture desktop state and reconciled all prior actions.",
      });
      expect(audit.quarantinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
      expect(audit.quarantineFile).toBe(result.quarantinePath.split(/[\\/]/u).at(-1));
      expect(owner.inspect(identity)).toBeUndefined();

      const nextLease = owner.acquire(identity, "next-run");
      nextLease.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires explicit review before quarantining an abandoned active Host lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-owner-recovery-active-"));
    const identity = "cua-local-physical-desktop:test";
    const owner = new ProcessSharedEnvironmentOwner(directory);
    try {
      const producer = runOwnerProcess(directory, identity, "hold", "host-crash-run");
      expect(producer.error).toBeUndefined();
      expect(producer.status).toBe(0);
      expect(owner.inspect(identity)).toMatchObject({ runId: "host-crash-run", state: "pending_cleanup" });
      expect(() => owner.recoverLease({
        identity,
        expectedRunId: "host-crash-run",
        expectedLeaseHash: environmentLeaseHash(identity),
        expectedState: "pending_cleanup",
        operator: "fixture reviewer",
        inspectionNote: "This state does not match the on-disk active lease.",
        externalStateInspected: true,
      })).toThrow(/does not match/iu);

      const result = owner.recoverLease({
        identity,
        expectedRunId: "host-crash-run",
        expectedLeaseHash: environmentLeaseHash(identity),
        expectedState: "active",
        operator: "fixture reviewer",
        inspectionNote: "Inspected the desktop and reconciled the prior Run before recovery.",
        externalStateInspected: true,
      });
      const quarantined = JSON.parse(await readFile(result.quarantinePath, "utf8")) as { runId: string; state: string };
      const audit = JSON.parse(await readFile(result.auditPath, "utf8")) as { expectedState: string; priorOwnerProcessId: number };
      expect(quarantined).toMatchObject({ runId: "host-crash-run", state: "active" });
      expect(audit.expectedState).toBe("active");
      expect(audit.priorOwnerProcessId).toBeGreaterThan(0);
      expect(owner.inspect(identity)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes acquire and recovery while another per-identity operation marker is held", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-owner-recovery-race-"));
    const identity = "cua-local-physical-desktop:test";
    const leaseHash = environmentLeaseHash(identity);
    const leasePath = join(directory, `${leaseHash}.json`);
    const operationPath = join(directory, `${leaseHash}.operation.json`);
    const owner = new ProcessSharedEnvironmentOwner(directory);
    try {
      const producer = runOwnerProcess(directory, identity, "pending-hold", "old-run");
      expect(producer.error).toBeUndefined();
      expect(producer.status).toBe(0);

      // Inject the point between recovery's final lease validation and rename.
      // Both contenders must fail while this critical-section marker exists.
      await writeFile(operationPath, JSON.stringify({
        version: 1,
        identity,
        operation: "recover",
        ownerProcessId: process.pid,
        token: "fixture-recovery-token",
        startedAt: new Date().toISOString(),
      }), { encoding: "utf8", flag: "wx" });

      const acquisition = runOwnerProcess(directory, identity, "expect-block", "new-run");
      expect(acquisition.error).toBeUndefined();
      expect(acquisition.status).toBe(0);
      expect(acquisition.stdout).toContain("unfinished owner operation marker");
      expect(() => owner.recoverLease({
        identity,
        expectedRunId: "old-run",
        expectedLeaseHash: leaseHash,
        expectedState: "pending_cleanup",
        operator: "fixture reviewer",
        inspectionNote: "The competing recovery marker is held for this race fixture.",
        externalStateInspected: true,
      })).toThrow(/unfinished owner operation marker/iu);
      expect(owner.inspect(identity)).toMatchObject({ runId: "owner-operation:recover", state: "pending_cleanup" });
      expect(JSON.parse(await readFile(leasePath, "utf8"))).toMatchObject({ runId: "old-run", state: "pending_cleanup" });

      await unlink(operationPath);
      const result = owner.recoverLease({
        identity,
        expectedRunId: "old-run",
        expectedLeaseHash: leaseHash,
        expectedState: "pending_cleanup",
        operator: "fixture reviewer",
        inspectionNote: "Inspected the fixture state after serializing the race.",
        externalStateInspected: true,
      });
      const nextLease = owner.acquire(identity, "new-run");
      expect(JSON.parse(await readFile(result.quarantinePath, "utf8"))).toMatchObject({ runId: "old-run" });
      expect(() => owner.recoverLease({
        identity,
        expectedRunId: "old-run",
        expectedLeaseHash: leaseHash,
        expectedState: "pending_cleanup",
        operator: "fixture reviewer",
        inspectionNote: "A stale recovery must not move the new Run's lease.",
        externalStateInspected: true,
      })).toThrow(/does not match/iu);
      expect(owner.inspect(identity)).toMatchObject({ runId: "new-run", state: "active" });
      nextLease.release();
    } finally {
      try { await unlink(operationPath); } catch { /* the fixture may already have released its marker */ }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
