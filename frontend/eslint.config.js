import { FlatCompat } from "@eslint/eslintrc";
import path from "node:path";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

const compat = new FlatCompat({
  baseDirectory: dirname,
  resolvePluginsRelativeTo: dirname,
});

export default [
  {
    ignores: ["build/**", "coverage/**", "node_modules/**", ".react-router/**"],
  },
  ...compat.config({
    parser: "@typescript-eslint/parser",
    parserOptions: {
      project: "./tsconfig.json",
      tsconfigRootDir: dirname,
    },
    extends: [
      "airbnb",
      "prettier",
      "plugin:@typescript-eslint/eslint-recommended",
      "plugin:@typescript-eslint/recommended",
      "plugin:react/recommended",
      "plugin:react-hooks/recommended",
      "plugin:@tanstack/query/recommended",
    ],
    plugins: ["prettier", "unused-imports", "i18next"],
    rules: {
      "i18next/no-literal-string": "error",
      "unused-imports/no-unused-imports": "error",
      "prettier/prettier": ["error"],
      "@typescript-eslint/prefer-optional-chain": "error",
      "import/extensions": [
        "error",
        "ignorePackages",
        {
          "": "never",
          js: "never",
          jsx: "never",
          ts: "never",
          tsx: "never",
        },
      ],
    },
    settings: {
      "import/parsers": {
        "@typescript-eslint/parser": [".ts", ".tsx"],
      },
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: "./tsconfig.json",
        },
        node: true,
      },
      react: {
        version: "detect",
      },
    },
    overrides: [
      {
        files: ["*.ts", "*.tsx"],
        excludedFiles: ["src/hooks/query/query-keys.ts"],
        rules: {
          "camelcase": "off",
          "no-array-constructor": "off",
          "no-dupe-class-members": "off",
          "no-implied-eval": "off",
          "no-loss-of-precision": "off",
          "no-redeclare": "off",
          "no-shadow": "off",
          "no-unused-vars": "off",
          "no-use-before-define": "off",
          "no-param-reassign": [
            "error",
            {
              props: true,
              ignorePropertyModificationsFor: ["acc", "state"],
            },
          ],
          "no-restricted-syntax": [
            "error",
            {
              selector:
                "Property[key.name='queryKey'] > ArrayExpression[elements.0.value='settings']",
              message:
                "Use SETTINGS_QUERY_KEYS helpers instead of raw settings query key arrays.",
            },
          ],
          "react/require-default-props": "off",
          "import/prefer-default-export": "off",
          "no-underscore-dangle": "off",
          "jsx-a11y/no-static-element-interactions": "off",
          "jsx-a11y/click-events-have-key-events": "off",
          "jsx-a11y/label-has-associated-control": [
            2,
            {
              required: {
                some: ["nesting", "id"],
              },
            },
          ],
          "react/prop-types": "off",
          "react/no-array-index-key": "off",
          "react-hooks/exhaustive-deps": "off",
          "import/no-extraneous-dependencies": "off",
          "react/react-in-jsx-scope": "off",
        },
        parserOptions: {
          project: ["**/tsconfig.json"],
          tsconfigRootDir: dirname,
        },
      },
    ],
  }),
];
