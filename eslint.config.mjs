import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      '**/vitest.config.*.timestamp*',
      '**/vite.config.*.timestamp*',
      '**/android/**',
      '**/ios/**',
      '**/mockup/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            {
              // App shell: wires features, registers providers at startup.
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: [
                'type:feature',
                'type:state',
                'type:ui',
                'type:provider',
                'type:music-source',
                'type:models',
                'type:storage',
                'type:player',
                'type:metadata',
                'type:import',
              ],
            },
            {
              // Screens never touch providers, storage or the audio engine directly.
              sourceTag: 'type:feature',
              onlyDependOnLibsWithTags: ['type:state', 'type:ui', 'type:models'],
            },
            {
              sourceTag: 'type:state',
              onlyDependOnLibsWithTags: [
                'type:models',
                'type:music-source',
                'type:storage',
                'type:player',
                'type:metadata',
                'type:import',
              ],
            },
            {
              // Pure iTunes/Deezer lookup: no workspace dependencies, injected fetch.
              sourceTag: 'type:metadata',
              onlyDependOnLibsWithTags: [],
            },
            {
              // Pure Spotify import parsing + match scoring (libs/spotify-import).
              sourceTag: 'type:import',
              onlyDependOnLibsWithTags: ['type:models', 'type:metadata'],
            },
            {
              // Concrete providers depend on shared types only.
              sourceTag: 'type:provider',
              onlyDependOnLibsWithTags: ['type:models'],
            },
            {
              sourceTag: 'type:music-source',
              onlyDependOnLibsWithTags: ['type:models'],
            },
            {
              sourceTag: 'type:storage',
              onlyDependOnLibsWithTags: ['type:models'],
            },
            {
              sourceTag: 'type:player',
              onlyDependOnLibsWithTags: ['type:models'],
            },
            {
              // Downloader server (apps/server): shared types only, never app code.
              sourceTag: 'type:server',
              onlyDependOnLibsWithTags: ['type:models'],
            },
            {
              sourceTag: 'type:ui',
              onlyDependOnLibsWithTags: [],
            },
            {
              sourceTag: 'type:models',
              onlyDependOnLibsWithTags: [],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
