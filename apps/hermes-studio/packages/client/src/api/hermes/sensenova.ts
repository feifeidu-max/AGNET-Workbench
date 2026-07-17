import { request } from '../client'

export interface SenseNovaConfig {
  provider: 'custom:sensenova'
  name: string
  base_url: string
  model: string
  api_mode: 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'bedrock_converse' | 'codex_app_server'
  api_key_configured: boolean
  api_key_hint: string
  models: string[]
}

export interface SenseNovaTestResponse {
  success: boolean
  base_url: string
  models: string[]
  model: string
  model_available: boolean
}

export async function fetchSenseNovaConfig(): Promise<SenseNovaConfig> {
  return request<SenseNovaConfig>('/api/hermes/config/sensenova')
}

export async function saveSenseNovaConfig(data: {
  base_url: string
  model: string
  api_key?: string
  models?: string[]
  api_mode?: SenseNovaConfig['api_mode']
  clear_api_key?: boolean
}): Promise<SenseNovaConfig & { success: boolean }> {
  return request<SenseNovaConfig & { success: boolean }>('/api/hermes/config/sensenova', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function testSenseNovaConfig(data: {
  base_url?: string
  model?: string
  api_key?: string
}): Promise<SenseNovaTestResponse> {
  return request<SenseNovaTestResponse>('/api/hermes/config/sensenova/test', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
