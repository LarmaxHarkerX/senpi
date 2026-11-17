import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMovedPathProbe } from "../../src/core/extensions/builtin/moved-path-guard/resolve-async.ts";
import { createMovedLayout, type MovedLayout } from "./moved-path-guard-fixtures.ts";

// senpi#3404: abandoning a slow canonical step must stop its later traversal.
const pending = vi.hoisted(() => ({
	signal: undefined as AbortSignal | undefined,
	release: undefined as ((path: string) => void) | undefined,
}));
vi.mock("../../src/core/tools/filesystem-policy.ts", async (original) => {
	const actual = await original<typeof import("../../src/core/tools/filesystem-policy.ts")>();
	return {
		...actual,
		canonicalizeFilesystemPath: (path: string, signal?: AbortSignal) => {
			if (!path.includes("SLOW")) return actual.canonicalizeFilesystemPath(path, signal);
			pending.signal = signal;
			return new Promise<string>((release) => {
				pending.release = release;
			});
		},
	};
});

let layout: MovedLayout | undefined;
afterEach(() => {
	vi.useRealTimers();
	layout?.cleanup();
	layout = undefined;
	pending.signal = undefined;
	pending.release = undefined;
});

it("aborts an expired canonical step while preserving the moved-path decision", async () => {
	layout = createMovedLayout();
	const probe = createMovedPathProbe();
	vi.useFakeTimers();
	const result = probe.resolve(join(layout.oldWorktree, "SLOW"));
	await vi.advanceTimersByTimeAsync(501);
	vi.useRealTimers();
	expect((await result)?.mappedPath).toBe(join(layout.newWorktree, "SLOW"));
	expect(probe.timedOut).toBe(true);
	expect(pending.signal?.aborted).toBe(true);
});

it("aborts in-flight canonicalization when the probe stops", async () => {
	layout = createMovedLayout();
	const probe = createMovedPathProbe();
	const path = join(layout.home, "SLOW");
	const result = probe.resolve(path);
	probe.stop();
	pending.release?.(path);
	expect(await result).toBeUndefined();
	expect(pending.signal?.aborted).toBe(true);
});

it("starts no canonicalization after the probe stopped", async () => {
	layout = createMovedLayout();
	const probe = createMovedPathProbe();
	probe.stop();
	expect(await probe.resolve(join(layout.home, "SLOW"))).toBeUndefined();
	expect(pending.signal).toBeUndefined();
});
