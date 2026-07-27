import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Generated artefacts — linting them reports on code we did not write.
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    '.flowforge/**',
  ]),
  {
    // The kernel is deliberately framework-free; these rules are React-specific
    // and only meaningful under src/components and src/app.
    files: ['src/core/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
]);

export default eslintConfig;
