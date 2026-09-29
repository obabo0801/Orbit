import javascript from "@eslint/js";

const syntax = [
  "error",
  {
    selector:
      ":matches(ReturnStatement, " +
      "ArrowFunctionExpression[expression=true]) > " +
      ":matches(LogicalExpression, ConditionalExpression, " +
      "BinaryExpression:has(BinaryExpression > :not(Identifier, " +
      "Literal, MemberExpression)), " +
      "TemplateLiteral:has(TemplateLiteral > :not(TemplateElement, " +
      "Identifier, Literal, MemberExpression)), " +
      "UnaryExpression:has(UnaryExpression > :not(Identifier, " +
      "Literal, MemberExpression)))",
    message: "Prepare the result before returning it.",
  },
  {
    selector:
      "LogicalExpression:matches([operator='&&'], " +
      "[operator='||']):has(LogicalExpression > :not(Identifier, " +
      "LogicalExpression))",
    message: "Separate compound conditions into prepared values.",
  },
  {
    selector: "NewExpression[callee.name='Error'][arguments.length=0]",
    message: "Provide an identifiable error message.",
  },
  {
    selector:
      "NewExpression[callee.name='Error'] > Literal.arguments[value=/^\\s*$/]",
    message: "Provide a nonempty error message.",
  },
];

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  javascript.configs.recommended,
  {
    files: ["**/*.js"],
    rules: {
      curly: ["error", "all"],
      "prefer-const": "error",
      "no-multiple-empty-lines": ["error", { max: 1, maxEOF: 0, maxBOF: 0 }],
      "padded-blocks": ["error", "never"],
      "no-restricted-syntax": syntax,
      "no-restricted-imports": ["error", { patterns: ["./*", "../*"] }],
      "id-denylist": ["error", "current", "payload", "el", "element"],
    },
  },
  {
    files: ["index.js", "core/**/*.js"],
    languageOptions: { globals: { document: "readonly" } },
    rules: {
      "no-restricted-syntax": [
        ...syntax,
        {
          selector: "MemberExpression[property.name='style']",
          message: "Use CSS and shared state instead of inline styles.",
        },
      ],
    },
  },
];
