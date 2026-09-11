import { describe, it, expect, vi } from "vitest";

vi.mock("../configs/index.js", () => ({
  default: { server: { publicOrigin: "https://sitey.my" } },
  server: { publicOrigin: "https://sitey.my" },
}));

const { getManagedDomains } = await import("../services/managedDomain.js");

/**
 * 정본 도메인이 목록 맨 앞에 온다.
 *
 * 화면의 기본 선택이 이 순서에서 나온다. 순서를 아무도 정하지 않으면
 * «테이블에 먼저 들어간 것»이 기본값이 되고, 그래서 sitey.one 이 첫 줄에
 * 서 있었다 (Jay, 2026-09-11).
 *
 * 가나다순은 SQL 의 ORDER BY 가 하므로 여기서 시험하지 않는다. 가짜 DB 는
 * 이미 정렬된 것을 돌려주는 척하고, 이 파일은 «그다음에 무엇이 일어나는가»만
 * 본다 — 정본을 앞으로 끌어내고 나머지 순서는 건드리지 않는 것.
 */
describe("getManagedDomains", () => {
  const fake = (sortedNames) => ({
    mysql: {
      execute: async () => [
        sortedNames.map((n, i) => ({ id: i + 1, domain_name: n })),
      ],
    },
  });

  it("정본을 앞으로 끌어내고 나머지 순서는 그대로 둔다", async () => {
    const out = await getManagedDomains(
      fake(["officials.my", "officials.one", "sitey.my", "sitey.one"])
    );
    expect(out.map((d) => d.domain)).toEqual([
      "sitey.my",
      "officials.my",
      "officials.one",
      "sitey.one",
    ]);
  });

  it("정본이 목록에 없으면 받은 순서 그대로", async () => {
    const out = await getManagedDomains(fake(["officials.my", "sitey.one"]));
    expect(out.map((d) => d.domain)).toEqual(["officials.my", "sitey.one"]);
  });

  it("대소문자가 달라도 정본으로 알아본다", async () => {
    const out = await getManagedDomains(fake(["officials.my", "Sitey.MY"]));
    expect(out[0].domain).toBe("Sitey.MY");
  });

  it("SQL 에 정렬을 시킨다 — 순서 없는 질의로 돌아가지 않게", async () => {
    let sql = "";
    await getManagedDomains({
      mysql: { execute: async (text) => { sql = text; return [[]]; } },
    });
    expect(sql).toMatch(/ORDER BY domain_name/);
  });
});
