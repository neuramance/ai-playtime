import type { Rule, SourceCode } from "eslint";
import type { Expression, Identifier, MemberExpression, Node, SpreadElement } from "estree";

const EQUALITY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual"]);

type Argument = Expression | SpreadElement | undefined;

function resolve(sourceCode: SourceCode, identifier: Identifier) {
  const reference = sourceCode
    .getScope(identifier)
    .references.find((ref) => ref.identifier === identifier);
  return reference?.resolved ?? undefined;
}

function isVitestExpect(sourceCode: SourceCode, callee: Node): boolean {
  if (callee.type !== "Identifier") return false;
  const definition = resolve(sourceCode, callee)?.defs[0];
  if (definition?.type !== "ImportBinding" || definition.node.type !== "ImportSpecifier") {
    return false;
  }
  const { imported } = definition.node;
  const name = imported.type === "Identifier" ? imported.name : imported.value;
  return name === "expect" && definition.parent.source.value === "vitest";
}

function isSameLiteral(actual: Argument, expected: Argument): boolean {
  return (
    actual?.type === "Literal" && expected?.type === "Literal" && actual.value === expected.value
  );
}

function isSameBinding(sourceCode: SourceCode, actual: Argument, expected: Argument): boolean {
  if (actual?.type !== "Identifier" || expected?.type !== "Identifier") return false;
  const binding = resolve(sourceCode, actual);
  return binding !== undefined && binding === resolve(sourceCode, expected);
}

function assertionSubject(matcher: MemberExpression): Node {
  const { object } = matcher;
  const negated =
    object.type === "MemberExpression" &&
    object.property.type === "Identifier" &&
    object.property.name === "not";
  return negated ? object.object : object;
}

export const noTautologicalAssertion: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow assertions that compare a value with itself" },
    messages: {
      tautology:
        "This assertion compares a value with itself; derive the expectation independently.",
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    return {
      CallExpression(node) {
        const matcher = node.callee;
        if (matcher.type !== "MemberExpression" || matcher.property.type !== "Identifier") return;
        if (matcher.computed || !EQUALITY_MATCHERS.has(matcher.property.name)) return;
        const subject = assertionSubject(matcher);
        if (subject.type !== "CallExpression" || !isVitestExpect(sourceCode, subject.callee))
          return;
        const [actual] = subject.arguments;
        const [expected] = node.arguments;
        if (isSameLiteral(actual, expected) || isSameBinding(sourceCode, actual, expected)) {
          context.report({ node, messageId: "tautology" });
        }
      },
    };
  },
};
