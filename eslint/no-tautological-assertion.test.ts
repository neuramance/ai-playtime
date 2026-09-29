import { RuleTester } from "eslint";
import { it } from "vitest";
import { noTautologicalAssertion } from "./no-tautological-assertion.ts";

const tautology = [{ messageId: "tautology" }];

it("flags only assertions that compare a value with itself", () => {
  new RuleTester().run("no-tautological-assertion", noTautologicalAssertion, {
    valid: [
      'import { expect } from "vitest"; expect(sum(2, 2)).toBe(4);',
      'import { expect } from "vitest"; const a = 1; const b = 1; expect(a).toBe(b);',
      'import { expect } from "vitest"; expect(roll()).toBe(roll());',
      'import { expect } from "vitest"; expect(left).toBe(right);',
      'import { expect } from "vitest"; expect(record.total).toEqual(record.total);',
      'import { expect } from "vitest"; expect(/a/).toEqual(/a/);',
      'import { expect, vi } from "vitest"; const spy = vi.fn(); spy(1); expect(spy).toHaveBeenCalledWith(1);',
      'import { expect } from "vitest"; const value = 3; expect(value).toBeGreaterThan(value - 1);',
      "const expect = (v) => ({ toBe() {} }); const x = 1; expect(x).toBe(x);",
      'import { expect } from "other"; const x = 1; expect(x).toBe(x);',
    ],
    invalid: [
      { code: 'import { expect } from "vitest"; expect(true).toBe(true);', errors: tautology },
      {
        code: 'import { expect } from "vitest"; const value = make(); expect(value).toEqual(value);',
        errors: tautology,
      },
      {
        code: 'import { expect as check } from "vitest"; const v = make(); check(v).toStrictEqual(v);',
        errors: tautology,
      },
      {
        code: 'import { expect } from "vitest"; const v = make(); expect(v).not.toBe(v);',
        errors: tautology,
      },
      {
        code: 'import { expect, it } from "vitest"; const v = make(); it("t", () => { expect(v).toBe(v); });',
        errors: tautology,
      },
      { code: 'import { expect } from "vitest"; expect(NaN).toBe(NaN);', errors: tautology },
    ],
  });
});
