import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export const config = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'No default exports (AGENTS.md code style).'
        }
      ]
    }
  },
  {
    // AGENTS.md layout rule: core is backend-agnostic business logic.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@modelcontextprotocol/*', '@a2a-js/*'],
              message: 'src/core must not import the MCP or A2A SDK (AGENTS.md layout).'
            }
          ]
        }
      ]
    }
  },
  {
    // AGENTS.md layout rule: the A2A gateway never speaks MCP.
    files: ['src/a2a/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@modelcontextprotocol/*'],
              message: 'src/a2a must not import the MCP SDK (AGENTS.md layout).'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['eslint.config.js', 'vitest.config.ts'],
    rules: { 'no-restricted-syntax': 'off' }
  }
);

export default config;
