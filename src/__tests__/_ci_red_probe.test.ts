import { describe, expect, it } from "vitest";

// TEMPORARY: issue #351 の検証用。CI が赤いテストで fail することを確認したら削除する。
describe("ci red probe", () => {
  it("intentionally fails", () => {
    expect(1).toBe(2);
  });
});
