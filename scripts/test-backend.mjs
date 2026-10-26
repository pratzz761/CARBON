import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const python = fileURLToPath(new URL(process.platform === 'win32'
  ? '../.venv/Scripts/python.exe' : '../.venv/bin/python', import.meta.url))
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py', '-v'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', windowsHide: true,
})
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
