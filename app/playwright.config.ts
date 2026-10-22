import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e', timeout: 90000, expect: { timeout: 30000 },
  workers: 1, retries: 0,
  reporter: [['list'], ['json', { outputFile: `../artifacts/desktop/m4-${process.env.MOTION_PACKAGED_EXE ? 'packaged' : 'development'}-test-results.json` }]],
});
