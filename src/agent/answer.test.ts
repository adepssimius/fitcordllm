import { describe, expect, it } from "vitest";
import { answerText } from "./answer.js";

describe("answerText", () => {
  it("keeps text written before the last tool call", () => {
    const blocks = ["## Readiness: AMBER\n\nEasy 45min, Upper A.", "The soreness poll is under this message."];
    expect(answerText(blocks, "The soreness poll is under this message.")).toBe(
      "## Readiness: AMBER\n\nEasy 45min, Upper A.\n\nThe soreness poll is under this message.",
    );
  });

  it("drops empty blocks", () => {
    expect(answerText(["one", "  ", "\n", "two"], "two")).toBe("one\n\ntwo");
  });

  it("falls back to the result when no text was streamed", () => {
    expect(answerText([], "done")).toBe("done");
  });
});
