import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const opsRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = dirname(opsRoot)
const requireFromStudio = createRequire(join(repositoryRoot, 'apps', 'hermes-studio', 'package.json'))
const yaml = requireFromStudio('js-yaml')

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument near '${key ?? ''}'`)
    }
    result[key.slice(2)] = value
  }
  return result
}

function objectOrThrow(value, label) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a YAML mapping`)
  }
  return value
}

function atomicWrite(path, content) {
  const temporaryPath = `${path}.agnet-${process.pid}.tmp`
  const mode = existsSync(path) ? statSync(path).mode : 0o600
  const handle = openSync(temporaryPath, 'wx', mode)
  try {
    writeFileSync(handle, content, { encoding: 'utf8' })
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporaryPath, path)
}

function reconcileProfileEnv(envPath, tokenNames) {
  const original = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const hadTrailingNewline = /\r?\n$/.test(original)
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const kept = original.split(/\r?\n/).filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    return !match || (!tokenNames.has(match[1]) && match[1] !== 'HERMES_BRIDGE_TOOLSETS')
  })
  if (kept.length > 0 && kept.at(-1) === '') kept.pop()
  kept.push('HERMES_BRIDGE_TOOLSETS=llm-wiki')
  const updated = `${kept.join(newline)}${hadTrailingNewline || !original ? newline : ''}`
  if (updated === original) return false
  atomicWrite(envPath, updated)
  return true
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  for (const required of ['profile-dir', 'node', 'mcp-entrypoint', 'token-env-name']) {
    if (!args[required]) throw new Error(`Missing --${required}`)
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(args['token-env-name'])) {
    throw new Error('The token environment variable name is invalid')
  }

  const profileDir = resolve(args['profile-dir'])
  const nodeExecutable = resolve(args.node)
  const mcpEntrypoint = resolve(args['mcp-entrypoint'])
  const configPath = join(profileDir, 'config.yaml')
  const raw = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  const loaded = raw.trim() ? yaml.load(raw) : {}
  const config = objectOrThrow(loaded, 'config.yaml root')
  const before = JSON.stringify(config)

  const mcpServers = objectOrThrow(config.mcp_servers, 'mcp_servers')
  const server = objectOrThrow(mcpServers['llm-wiki'], 'mcp_servers.llm-wiki')
  const serverEnv = objectOrThrow(server.env, 'mcp_servers.llm-wiki.env')

  delete server.url
  delete server.headers
  delete server.transport
  delete serverEnv[args['token-env-name']]
  server.command = nodeExecutable
  server.args = [mcpEntrypoint]
  server.enabled = true
  server.env = {
    ...serverEnv,
    LLM_WIKI_API_TOKEN: '${LLM_WIKI_API_TOKEN}',
    LLM_WIKI_API_BASE_URL: '${LLM_WIKI_API_BASE_URL}',
    LLM_WIKI_MCP_TOOLSET: 'research',
  }
  mcpServers['llm-wiki'] = server
  config.mcp_servers = mcpServers

  const platformToolsets = objectOrThrow(config.platform_toolsets, 'platform_toolsets')
  platformToolsets.cli = ['llm-wiki']
  config.platform_toolsets = platformToolsets

  const agent = objectOrThrow(config.agent, 'agent')
  if (agent.disabled_toolsets !== undefined && !Array.isArray(agent.disabled_toolsets)) {
    throw new Error('agent.disabled_toolsets must be a YAML list')
  }
  const disabledToolsets = new Set((agent.disabled_toolsets ?? []).map((value) => String(value)))
  disabledToolsets.add('context_engine')
  disabledToolsets.add('kanban')
  agent.disabled_toolsets = [...disabledToolsets].sort()
  config.agent = agent

  const skills = objectOrThrow(config.skills, 'skills')
  if (skills.disabled !== undefined && !Array.isArray(skills.disabled)) {
    throw new Error('skills.disabled must be a YAML list')
  }
  const disabled = new Set((skills.disabled ?? []).map((value) => String(value)))
  disabled.add('llm-wiki')
  skills.disabled = [...disabled].sort()
  config.skills = skills

  const configChanged = before !== JSON.stringify(config)
  if (configChanged) {
    const output = yaml.dump(config, {
      indent: 2,
      lineWidth: -1,
      noCompatMode: true,
      noRefs: true,
      sortKeys: false,
    })
    atomicWrite(configPath, output)
  }

  const envChanged = reconcileProfileEnv(join(profileDir, '.env'), new Set([
    'LLM_WIKI_API_TOKEN',
    args['token-env-name'],
  ]))
  process.stdout.write(configChanged || envChanged ? 'changed\n' : 'unchanged\n')
}

try {
  main()
} catch (error) {
  process.stderr.write(`Research profile configuration failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
