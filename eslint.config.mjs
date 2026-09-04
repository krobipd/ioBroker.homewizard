import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // test/standards is this repo's own suite and gets linted; it sits
          // outside the tsconfig `include` (which stays on src/**, fleet master),
          // so the default project has to accept it.
          allowDefaultProject: ["*.mjs", "vitest.config.mts", "test/standards/*.test.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    ignores: [
      ".dev-server/",
      ".vscode/",
      "*.test.js",
      // Only the ioBroker template files under test/ stay out — `test/standards/`
      // is this repo's own suite and gets linted like every other test.
      "test/integration.js",
      "test/package.js",
      "*.config.mjs",
      "build",
      // Generated coverage report (npm run coverage) — never lint it.
      "coverage",
      "admin",
      "node_modules",
      "**/adapter-config.d.ts",
    ],
  },
];
