import { defineConfig, globalIgnores } from 'eslint/config'
import { tanstackConfig } from '@tanstack/eslint-config'
import convexPlugin from '@convex-dev/eslint-plugin'

export default defineConfig([
  ...tanstackConfig,
  ...convexPlugin.configs.recommended,
  // `.agents/skills` holds upstream skill content vendored verbatim, including
  // illustrative .tsx examples that live outside any tsconfig project — linting
  // them only produces parser errors. Kept in sync with `.prettierignore`.
  globalIgnores([
    'convex/_generated',
    'prettier.config.js',
    '.output',
    '.nitro',
    'dist',
    '.agents/skills',
    '.claude/skills',
  ]),
  // The candidate surface (/s/$token/...) is a separate bundle on purpose:
  // it must stay small and predictable because it runs on a stranger's phone,
  // once, with no second chance. The previous Interw shipped 2.96 MB of JS to
  // candidates because everything sat in one import graph — this rule is what
  // makes that regression fail CI instead of shipping.
  //
  // Allowed: `~/components/ui/*` primitives, `~/lib/*`, `~/components/candidate/*`.
  // Everything recruiter-facing (and the heavy libraries it pulls) is banned.
  {
    files: ['src/routes/s/**', 'src/components/candidate/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '~/components/app-shell/*',
                '~/components/ai/*',
                '~/components/ai-elements/*',
                '~/components/dashboard/*',
                '~/components/items/*',
                '~/components/data-table/*',
                '~/components/auth/*',
                '~/components/report/*',
              ],
              message:
                'The candidate surface must not import recruiter-app components. Use ~/components/ui/* primitives or add a component under ~/components/candidate/.',
            },
            {
              group: [
                'recharts',
                '@tanstack/react-table',
                '@convex-dev/agent*',
                'streamdown',
                '@zxcvbn-ts/*',
              ],
              message:
                'This library is recruiter-app-only. Keeping it out of the candidate bundle is the point — see eslint.config.mjs.',
            },
          ],
        },
      ],
    },
  },
  // shadcn/ui components are vendored from the shadcn CLI — we don't lint
  // their internal style (shadowed prop names, defensive nullish checks).
  {
    files: ['src/components/ui/**'],
    rules: {
      'no-shadow': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
])
