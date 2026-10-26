import { defineConfig } from '@playwright/test'

const windows = process.platform === 'win32'
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: process.env.PLAYWRIGHT_CHANNEL || (windows ? 'msedge' : 'chromium'),
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `${windows ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'} -m uvicorn backend.main:app --host 127.0.0.1 --port 8000`,
      url: 'http://127.0.0.1:8000/api/health',
      reuseExistingServer: false,
      env: { CARBON_DATA_DIR: `./test-results/browser-data-${Date.now()}`, MONGODB_URI: '' },
    },
    {
      command: 'npm run dev',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
    },
  ],
})
