/**
 * Run deadlines at the real launch boundary.
 *
 * Each case reads the retained runner launch config, or the status file the
 * runner writes, so a claim here covers the registered launch path rather than a
 * resolver return value. Children come from the scripted child-session fixture,
 * so no provider call is spent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAsyncConfigPath } from "../../src/shared/types.ts";
import { makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import {
	ASYNC_DIR, available, createSubagentExecutor, installAsyncExecutionHooks, isAsyncAvailable,
	makeAsyncExecutor, mockPi, readAsyncPayload, tempDir, waitForAsyncResultFile, waitForAsyncState,
} from "../support/async-execution-fixture.ts";

interface RetainedLaunch {
	timeoutMs?: number;
	deadlineAt?: number;
	checkpointBeforeDeadlineMs?: number;
	steps?: Array<{ timeoutMs?: number }>;
}

function readLaunch(id: string): RetainedLaunch {
	return JSON.parse(fs.readFileSync(getAsyncConfigPath(id), "utf-8")) as RetainedLaunch;
}

function workflowChildIds(id: string): string[] {
	const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as { steps?: Array<{ runId?: string }> };
	return (status.steps ?? []).map((step) => step.runId).filter((runId): runId is string => Boolean(runId));
}

const needsExecutor = () => !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined;

describe("agent run deadline at the launch boundary", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	it("retains no deadline for an omitted run deadline", { skip: needsExecutor(), timeout: 30_000 }, async () => {
		mockPi.onCall({ output: "finished without a deadline" });
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);

		const result = await executor.execute(
			"omitted-deadline-single",
			{ agent: "worker", task: "Explore the repository", async: true, acceptance: false },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const id = result.details?.asyncId;
		assert.ok(id, "expected an async launch");

		const launch = readLaunch(id);
		assert.equal(launch.timeoutMs, undefined, "an omitted run deadline reaches the runner omitted");
		assert.equal(launch.deadlineAt, undefined, "an omitted run deadline arms no run timer");
		assert.equal(launch.checkpointBeforeDeadlineMs, undefined, "an omitted run deadline schedules no checkpoint");
		assert.deepEqual(launch.steps?.map((step) => step.timeoutMs), [undefined], "an omitted child deadline reaches the runner omitted");

		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, true, payload.error);
		assert.equal(payload.timeoutMs, undefined);
		assert.equal(payload.deadlineAt, undefined);

		const status = await waitForAsyncState(id, (candidate) => candidate.state !== "running");
		assert.equal(status.timeoutMs, undefined);
		assert.equal(status.deadlineAt, undefined);
		assert.notEqual(status.timedOut, true);
	});

	it("retains an explicit deadline and kills the run when it expires", { skip: needsExecutor(), timeout: 30_000 }, async () => {
		mockPi.onCall({ steps: [{ waitForPath: path.join(tempDir, "never-released") }] });
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);

		const result = await executor.execute(
			"explicit-deadline-single",
			{ agent: "worker", task: "Wait for the deadline", async: true, acceptance: false, timeoutMs: 1_500 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const id = result.details?.asyncId;
		assert.ok(id, "expected an async launch");

		const launch = readLaunch(id);
		assert.equal(launch.timeoutMs, 1_500);
		assert.equal(typeof launch.deadlineAt, "number");

		const payload = await readAsyncPayload(id);
		assert.equal(payload.success, false);
		assert.equal(payload.timedOut, true);
		assert.equal(payload.timeoutMs, 1_500);
	});

	it("retains no deadline for omitted fan-out children", { skip: needsExecutor(), timeout: 40_000 }, async () => {
		mockPi.onCall({ output: "first child finished" });
		mockPi.onCall({ output: "second child finished" });
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);

		const result = await executor.execute(
			"omitted-deadline-fanout",
			{
				async: true,
				workflowScript: `await runs.all([
					{ key: "first", agent: "worker", task: "First child", acceptance: false, async: true },
					{ key: "second", agent: "worker", task: "Second child", acceptance: false, async: true }
				]); return "launched";`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const id = result.details?.asyncId;
		assert.ok(id, "expected an async workflow launch");
		await waitForAsyncState(id, (candidate) => candidate.state !== "running", 30_000);

		const childIds = workflowChildIds(id);
		assert.equal(childIds.length, 2, "expected both fan-out children to launch");
		for (const childId of childIds) {
			const child = readLaunch(childId);
			assert.equal(child.timeoutMs, undefined, "a fan-out child carries no implicit run deadline");
			assert.equal(child.deadlineAt, undefined);
			assert.equal((await readAsyncPayload(childId)).success, true);
		}
	});

	it("retains no deadline for an omitted foreground workflow child", { skip: needsExecutor(), timeout: 40_000 }, async () => {
		mockPi.onCall({ output: "workflow child finished" });
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);

		const result = await executor.execute(
			"omitted-deadline-foreground-workflow",
			{
				async: false,
				workflowScript: `const child = await runs.run("once", { agent: "worker", task: "Do the work", acceptance: false, async: true }); return child.runId;`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const childId = String(result.details?.workflow?.value ?? "");
		assert.ok(childId, "expected the workflow to report its child run id");

		const child = readLaunch(childId);
		assert.equal(child.timeoutMs, undefined, "the workflow child carries no implicit run deadline");
		assert.equal(child.deadlineAt, undefined);
		await waitForAsyncResultFile(childId, 15_000);
	});

	it("keeps a workflow child inside its explicit parent deadline", { skip: needsExecutor(), timeout: 40_000 }, async () => {
		mockPi.onCall({ output: "child finished" });
		const executor = makeAsyncExecutor([makeAgent("worker", { completionGuard: false })]);

		const result = await executor.execute(
			"parent-deadline-workflow",
			{
				async: true,
				timeoutMs: 300_000,
				workflowScript: `const child = await runs.run("once", { agent: "worker", task: "Do the work", acceptance: false, async: true }); return child.runId;`,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		const id = result.details?.asyncId;
		assert.ok(id, "expected an async workflow launch");

		const workflowStatus = await waitForAsyncState(id, (candidate) => candidate.state !== "running", 30_000);
		assert.equal(workflowStatus.state, "complete");
		const parentDeadlineAt = workflowStatus.deadlineAt;
		assert.equal(workflowStatus.timeoutMs, 300_000);
		assert.equal(typeof parentDeadlineAt, "number");

		const childId = workflowChildIds(id).at(0);
		assert.ok(childId, "expected a workflow child run id");
		const child = readLaunch(childId);
		const childTimeoutMs = child.timeoutMs;
		assert.equal(typeof childTimeoutMs, "number", "the child inherits the parent deadline");
		assert.ok(childTimeoutMs! <= 300_000);
		assert.equal(typeof child.deadlineAt, "number");
		assert.ok(child.deadlineAt! <= parentDeadlineAt! + 2_000, "the child deadline does not outlive its parent's");
		await waitForAsyncResultFile(childId, 15_000);
	});
});
