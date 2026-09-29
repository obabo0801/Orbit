import javascript from "@eslint/js";

export default [
  { ignores: ["node_modules/**", ".local/**"] },
  javascript.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Intl: "readonly",
        URL: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
      },
    },
    rules: {
      curly: ["error", "all"],
      "prefer-const": "error",
      "no-multiple-empty-lines": ["error", { max: 1, maxEOF: 0, maxBOF: 0 }],
      "padded-blocks": ["error", "never"],
      "no-restricted-syntax": [
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
      ],
      "no-restricted-imports": ["error", { patterns: ["./*", "../*"] }],
      "id-denylist": ["error", "current", "payload", "el", "element"],
    },
  },
];
