import { beforeEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/index.js";
import { recordPerson } from "./fitcord.js";

let store: Store;
beforeEach(() => {
  store = openStore(":memory:");
});

describe("recordPerson", () => {
  const mentioned = [
    { userId: "1", name: "Amy" },
    { userId: "2", name: "Ben" },
  ];

  it("records someone the message mentions, under the name Discord shows", () => {
    const r = recordPerson(store, "amy", mentioned, "2", " coach; fitcordllm developer ", "1");
    expect(r.ok).toBe(true);
    expect(store.people.get("amy", "2")).toMatchObject({ name: "Ben", role: "coach; fitcordllm developer", updatedBy: "1" });
  });

  it("refuses an id nobody in this message has", () => {
    const r = recordPerson(store, "amy", mentioned, "3", "coach", "1");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Amy <@1>, Ben <@2>");
    expect(store.people.list("amy")).toEqual([]);
  });
});
