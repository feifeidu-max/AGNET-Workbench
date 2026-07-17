import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

if (existsSync(new URL('../dist', import.meta.url))) {
  process.exit(0)
}

const npmCli = process.env.npm_execpath
const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
const args = npmCli ? [npmCli, 'run', 'build'] : ['run', 'build']
const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: process.env,
  shell: !npmCli && process.platform === 'win32',
})

if (result.error) {
  throw result.error
}

process.exit(result.status ?? 1)
