const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/**", "claude-plugin/lib/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "claude-plugin/bin/claude-switch"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: globals.node },
    rules: { "no-unused-vars": ["error", { caughtErrors: "none" }] },
  },
];
