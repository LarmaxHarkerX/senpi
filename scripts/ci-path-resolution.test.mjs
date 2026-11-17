#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

// CI configuration contract (senpi#3404): retained path regressions run in the existing platform jobs.
describe("path-resolution platform coverage", () => {
	const { jobs } = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
	const terminal = jobs["terminal-cross-os"];
	const macos = jobs["macos-combined"];
	const name = "Path resolution and guard cancellation regressions";
	const terminalStep = terminal.steps.find((step) => step.name === name);
	const macosStep = macos.steps.find((step) => step.name === name);

	it("runs both owners under Node and Bun with bounded steps and matching toolchains", () => {
		assert.ok(terminalStep);
		assert.ok(macosStep);
		assert.equal(terminalStep.run, macosStep.run);
		const commands = terminalStep.run.trim().split("\n");
		assert.equal(commands.length, 4);
		for (const file of ["test/filesystem-resolution.test.ts", "test/suite/moved-path-guard-cancellation.test.ts"]) {
			const selected = commands.filter((command) => command.includes(file));
			assert.equal(selected.length, 2, file);
			assert.equal(selected.filter((command) => command.includes(" bun --bun ")).length, 1, file);
			assert.equal(selected.filter((command) => command.includes(" vitest run ")).length, 1, file);
		}
		assert.deepEqual(terminal.steps.find((step) => step.name === "Setup Bun"),
			macos.steps.find((step) => step.name === "Setup Bun"));
		for (const step of [terminalStep, macosStep]) {
			assert.equal(step["timeout-minutes"], 3);
			assert.equal(step["continue-on-error"], undefined);
		}
	});

	it("keeps path tests inside the temp guard and independent of earlier suite failures", () => {
		for (const [job, step] of [[terminal, terminalStep], [macos, macosStep]]) {
			const index = job.steps.indexOf(step);
			const snapshot = job.steps.findIndex((candidate) => candidate.id &&
				step.if.includes(`steps.${candidate.id}.outcome`) && candidate.run?.includes("test-temp-guard.mjs snapshot"));
			assert.ok(snapshot >= 0 && snapshot < index);
			assert.ok(job.steps.slice(index + 1).some((candidate) => candidate.run?.includes("test-temp-guard.mjs check")));
			assert.match(step.if, /!cancelled\(\)/);
			for (const [cancelled, outcome, expected] of [[false, "success", true], [false, "failure", false], [true, "success", false]]) {
				const expression = step.if.slice(3, -2).replace("cancelled()", String(cancelled))
					.replace(/steps\.\w+\.outcome/g, JSON.stringify(outcome));
				assert.equal(Function(`return (${expression});`)(), expected, step.name);
			}
		}
		// The new terminal step follows both original suites, so its failure cannot suppress either.
		assert.ok(terminal.steps.indexOf(terminalStep) >
			terminal.steps.findIndex((step) => step.name === "Terminal extension + shell resolution tests"));
	});
});
