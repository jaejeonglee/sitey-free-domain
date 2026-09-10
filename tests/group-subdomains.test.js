import { describe, it, expect } from "vitest";
import domainRoutes from "../routes/domain.js";

const { groupBySubdomain } = domainRoutes;

/**
 * 조인이 늘린 행을 도메인 하나로 접는다.
 *
 * 실제로 겪은 일이다 — kgld-master-admin 이 같은 값의 TXT 를 세 줄 갖고 있어
 * 「내 도메인」에 같은 이름이 세 번 그려졌다 (2026-09-10).
 */
describe("groupBySubdomain", () => {
  const base = { subdomain: "demo", domain_name: "sitey.my", record_type: "CNAME" };

  it("TXT 가 여러 줄이어도 도메인은 한 줄이다", () => {
    const out = groupBySubdomain([
      { ...base, id: 85, host_prefix: "_vercel", txt_value: "a" },
      { ...base, id: 85, host_prefix: "_vercel", txt_value: "a" },
      { ...base, id: 85, host_prefix: "_vercel", txt_value: "a" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].txt_values).toEqual(["a"]);
  });

  it("값이 서로 다르면 전부 들고 있고, 입력칸에는 최신 것을 보인다", () => {
    const out = groupBySubdomain([
      { ...base, id: 31, host_prefix: "_vercel", txt_value: "old" },
      { ...base, id: 31, host_prefix: "_vercel", txt_value: "new" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].txt_values).toEqual(["old", "new"]);
    expect(out[0].txt_value).toBe("new");
  });

  it("TXT 가 없는 도메인도 한 줄로 남는다", () => {
    const out = groupBySubdomain([
      { ...base, id: 7, host_prefix: null, txt_value: null },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].txt_values).toEqual([]);
    expect(out[0].txt_value).toBeNull();
  });

  it("서로 다른 도메인은 합치지 않는다", () => {
    const out = groupBySubdomain([
      { ...base, id: 1, subdomain: "a", host_prefix: "_vercel", txt_value: "x" },
      { ...base, id: 2, subdomain: "b", host_prefix: "_vercel", txt_value: "y" },
    ]);
    expect(out.map((r) => r.subdomain)).toEqual(["a", "b"]);
  });
});
