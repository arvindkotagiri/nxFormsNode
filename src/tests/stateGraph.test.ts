import test from "node:test";
import assert from "node:assert/strict";
import { StateGraph } from "../utils/langchainCompat";

interface TestState {
  count: number;
  steps: string[];
}

test("StateGraph executes nodes in order and accumulates state changes", async () => {
  const workflow = new StateGraph<TestState>()
    .addNode("step1", async (state) => ({
      count: state.count + 1,
      steps: [...state.steps, "step1_done"],
    }))
    .addNode("step2", async (state) => ({
      count: state.count * 2,
      steps: [...state.steps, "step2_done"],
    }))
    .setEntryPoint("step1")
    .addEdge("step1", "step2")
    .compile();

  const finalState = await workflow.invoke({ count: 5, steps: [] });

  assert.equal(finalState.count, 12); // (5 + 1) * 2 = 12
  assert.deepEqual(finalState.steps, ["step1_done", "step2_done"]);
});
