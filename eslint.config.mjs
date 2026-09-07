import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // test/standards is this repo's own suite and gets linted through the
          // project service: test/** is covered by the tsconfig `include` (fleet
          // master), so it must NOT be listed here — typescript-eslint refuses a
          // file that is both in allowDefaultProject and in the project service.
          allowDefaultProject: ["*.mjs", "vitest.config.mts"],
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
      // Same class: the object-inventory harness and the fixture hook are mocha /
      // plain-CJS files that run outside the adapter's tsconfig project.
      "test/inventory.js",
      "test/inventory-hook.cjs",
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
