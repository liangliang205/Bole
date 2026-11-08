import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * 伯乐 ESLint 配置（flat config）。
 *
 * 目标：用可执行的规则把项目已经在遵守的约定固定下来，而不是重排代码风格。
 * - 不做格式化（缩进/引号交给编辑器），避免一次 lint 产生上万行 diff；
 * - 类型感知规则只选真正能抓住 bug 的几条（悬空 Promise、误用 Promise、await 非 Promise），
 *   不开 no-unsafe-* 这类会把现有 `as` 断言全部报错的规则；
 * - 前端 app.js 无框架、无构建，按浏览器全局环境单独配置。
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'runs/**',
      '.trash/**',
      'coverage/**',
      'pnpm-lock.yaml',
      // 本机下载的第三方 CLI（如腾讯 Agent Mail），不属于仓库源码
      'tools/**',
      '.claude/**',
    ],
  },

  // ------------------------------------------------------------------ JS
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // ------------------------------------------------------- 浏览器前端脚本
  {
    files: ['src/web/public/**/*.js', 'src/web/public/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // ------------------------------------------------------------ Node 脚本
  {
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ------------------------------------------------------------------ TS
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        // 用 TypeScript 语言服务做类型感知检查；tsconfig 已覆盖 src/scripts/tests
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 基础正确性：这些规则全仓库本来就满足，用来防止回归
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-debugger': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-throw-literal': 'error',
      // 中文排版里用全角空格（U+3000）做分隔是有意的；只放行模板字符串
      'no-irregular-whitespace': ['error', { skipTemplates: true }],

      // TypeScript 侧：项目坚持零 any、零 ts-ignore，这里把约定写成规则
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          minimumDescriptionLength: 6,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],

      // 类型感知：只保留最可能造成线上事故的三条
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  // 测试与测试替身：允许空断言脚手架、允许抛字符串等灵活性
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-throw-literal': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // node:test 的 test()/describe() 由运行器自己驱动 Promise，不 await 才是正确用法
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
