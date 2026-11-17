import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeFilesystemPath } from "../src/policy/filesystem.ts";
import { createLocalFileOps } from "../src/files/local-files.ts";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import { opErrorCode } from "../src/errors.ts";

// senpi#3404: a deadline must bound fallback traversal as well as opening-based resolution.
const io = vi.hoisted(() => ({
	hangRealpath: false,
	hangLstat: false,
	error: "",
	lstatError: "",
	links: new Map<string, string>(),
	realpathCalls: 0,
	lstatCalls: 0,
	release: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		realpath: async (path: string) => {
			io.realpathCalls++;
			if (io.error) throw Object.assign(new Error(io.error), { code: io.error });
			if (io.hangRealpath)
				return new Promise<string>((release) => {
					io.release = release;
				});
			return actual.realpath(path);
		},
		lstat: async (path: string) => {
			io.lstatCalls++;
			if (io.hangLstat) return new Promise<never>(() => {});
			if (io.lstatError) throw Object.assign(new Error(io.lstatError), { code: io.lstatError });
			if (io.links.has(path)) return { isSymbolicLink: () => true };
			return actual.lstat(path);
		},
		readlink: async (path: string) => io.links.get(path) ?? actual.readlink(path),
	};
});

let root = "";
beforeEach(() => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "path-resolution-")));
});
afterEach(() => {
	vi.useRealTimers();
	io.hangRealpath = false;
	io.hangLstat = false;
	io.error = "";
	io.lstatError = "";
	io.links.clear();
	io.realpathCalls = 0;
	io.lstatCalls = 0;
	io.release = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe("filesystem resolution", () => {
	it("resolves existing files and missing descendants through their real parent", async () => {
		writeFileSync(join(root, "file"), "value");
		expect(await canonicalizeFilesystemPath(join(root, "file"))).toBe(join(root, "file"));
		expect(await canonicalizeFilesystemPath(join(root, "missing", "new"))).toBe(join(root, "missing", "new"));
	});

	it("resolves junctions or directory links before appending missing descendants", async () => {
		mkdirSync(join(root, "target"));
		symlinkSync(join(root, "target"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
		expect(await canonicalizeFilesystemPath(join(root, "alias", "new"))).toBe(join(root, "target", "new"));
	});

	it.each(["EACCES", "EIO", "ELOOP"])("preserves %s instead of guessing a canonical path", async (code) => {
		io.error = code;
		await expect(canonicalizeFilesystemPath(root)).rejects.toMatchObject({ code });
	});

	it("uses bounded asynchronous traversal when opening-based resolution stalls", async () => {
		io.hangRealpath = true;
		vi.useFakeTimers();
		const result = canonicalizeFilesystemPath(join(root, "missing"));
		await vi.advanceTimersByTimeAsync(2001);
		expect(await result).toBe(join(root, "missing"));
		expect(io.lstatCalls).toBeGreaterThan(0);
	});

	it("rejects instead of blocking when both stages stall", async () => {
		io.hangRealpath = true;
		io.hangLstat = true;
		vi.useFakeTimers();
		const result = canonicalizeFilesystemPath(root);
		const rejected = expect(result).rejects.toMatchObject({
			code: "io_error",
			message: expect.stringContaining("timed out"),
		});
		await vi.advanceTimersByTimeAsync(4001);
		await rejected;
	});

	it.each(["EACCES", "EIO", "ELOOP"])("preserves %s from fallback traversal", async (code) => {
		io.hangRealpath = true;
		io.lstatError = code;
		vi.useFakeTimers();
		const result = canonicalizeFilesystemPath(root);
		const rejected = expect(result).rejects.toMatchObject({ code });
		await vi.advanceTimersByTimeAsync(2001);
		await rejected;
	});

	it.each(["absolute", "relative", "drive-rooted"])("resolves a %s link target during fallback", async (kind) => {
		mkdirSync(join(root, "elsewhere", "dir"), { recursive: true });
		const target =
			kind === "relative"
				? `jump${sep}..${sep}secret`
				: kind === "drive-rooted" && process.platform === "win32"
					? `${sep}${root.slice(parse(root).root.length)}${sep}elsewhere${sep}secret`
					: join(root, "elsewhere", "secret");
		io.links.set(join(root, "entry"), target);
		io.links.set(join(root, "jump"), join(root, "elsewhere", "dir"));
		io.hangRealpath = true;
		vi.useFakeTimers();
		const result = canonicalizeFilesystemPath(join(root, "entry"));
		await vi.advanceTimersByTimeAsync(2001);
		expect(await result).toBe(join(root, "elsewhere", "secret"));
	});

	it("bounds cyclic links during fallback", async () => {
		io.links.set(join(root, "loop"), "loop");
		io.hangRealpath = true;
		vi.useFakeTimers();
		const result = canonicalizeFilesystemPath(join(root, "loop"));
		const rejected = expect(result).rejects.toMatchObject({ code: "io_error" });
		await vi.advanceTimersByTimeAsync(2001);
		await rejected;
	});

	it("starts no I/O for an already cancelled resolution", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(canonicalizeFilesystemPath(root, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(io.realpathCalls).toBe(0);
	});

	it("cancels opening-based resolution and ignores late completion", async () => {
		io.hangRealpath = true;
		vi.useFakeTimers();
		const controller = new AbortController();
		const result = canonicalizeFilesystemPath(root, controller.signal);
		const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await vi.advanceTimersByTimeAsync(2001);
		await rejected;
		io.release?.(root);
		await vi.advanceTimersByTimeAsync(2001);
		expect(io.lstatCalls).toBe(0);
	});

	it("cancels stalled fallback without waiting for its deadline", async () => {
		io.hangRealpath = true;
		io.hangLstat = true;
		vi.useFakeTimers();
		const controller = new AbortController();
		const result = canonicalizeFilesystemPath(root, controller.signal);
		const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
		await vi.advanceTimersByTimeAsync(2001);
		controller.abort();
		await rejected;
	});

	it.each([false, true])(
		"cancels a policy-bound write before traversal continues (already aborted: %s)",
		async (already) => {
			writeFileSync(join(root, "file"), "original");
			io.hangRealpath = true;
			vi.useFakeTimers();
			const controller = new AbortController();
			if (already) controller.abort();
			let outcome = "pending";
			const operation = createLocalFileOps({})
				.write(
					{ path: join(root, "file"), bytes: Buffer.from("wrong") },
					{
						scope: { id: "test", root },
						principal: { kind: "local-session", id: "test" },
						signal: controller.signal,
						limits: DEFAULT_LIMITS,
						policy: {},
						pathLock: "caller",
					},
				)
				.then(
					() => {
						outcome = "written";
					},
					(error: unknown) => {
						outcome = opErrorCode(error);
					},
				);
			if (!already) controller.abort();
			await vi.advanceTimersByTimeAsync(0);
			expect(outcome).toBe("aborted");
			await operation;
			expect(io.lstatCalls).toBe(0);
		},
	);
});
