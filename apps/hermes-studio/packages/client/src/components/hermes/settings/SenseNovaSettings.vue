<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NForm, NFormItem, NInput, NSelect, NSpin, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchSenseNovaConfig, saveSenseNovaConfig, testSenseNovaConfig, type SenseNovaConfig } from '@/api/hermes/sensenova'
import { useModelsStore } from '@/stores/hermes/models'
import { useAppStore } from '@/stores/hermes/app'

const { t } = useI18n()
const message = useMessage()
const modelsStore = useModelsStore()
const appStore = useAppStore()

const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const form = ref({
  base_url: '',
  model: '',
  api_key: '',
})
const configured = ref(false)
const keyHint = ref('')
const availableModels = ref<string[]>([])
const lastTestOk = ref<boolean | null>(null)

const modelOptions = computed(() => availableModels.value.map(model => ({ label: model, value: model })))
const keyPlaceholder = computed(() => configured.value && keyHint.value
  ? t('settings.models.sensenova.keyConfigured', { hint: keyHint.value })
  : t('settings.models.sensenova.keyPlaceholder'))

function applyConfig(config: SenseNovaConfig) {
  form.value.base_url = config.base_url
  form.value.model = config.model
  configured.value = config.api_key_configured
  keyHint.value = config.api_key_hint
  availableModels.value = Array.from(new Set([...(config.models || []), config.model].filter(Boolean)))
}

async function load() {
  loading.value = true
  try {
    applyConfig(await fetchSenseNovaConfig())
  } catch (error: any) {
    message.error(error?.message || t('settings.models.sensenova.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function testConnection() {
  testing.value = true
  lastTestOk.value = null
  try {
    const result = await testSenseNovaConfig({
      base_url: form.value.base_url.trim(),
      model: form.value.model.trim(),
      api_key: form.value.api_key.trim() || undefined,
    })
    availableModels.value = result.models
    lastTestOk.value = true
    if (!form.value.model && result.models.length > 0) form.value.model = result.models[0]
    if (result.model && !result.model_available) {
      message.warning(t('settings.models.sensenova.modelUnavailable'))
    } else {
      message.success(t('settings.models.sensenova.testSuccess', { count: result.models.length }))
    }
  } catch (error: any) {
    lastTestOk.value = false
    message.error(error?.message || t('settings.models.sensenova.testFailed'))
  } finally {
    testing.value = false
  }
}

async function save() {
  if (!form.value.base_url.trim() || !form.value.model.trim()) {
    message.warning(t('settings.models.sensenova.required'))
    return
  }
  saving.value = true
  try {
    const result = await saveSenseNovaConfig({
      base_url: form.value.base_url.trim(),
      model: form.value.model.trim(),
      models: availableModels.value,
      api_key: form.value.api_key.trim() || undefined,
    })
    applyConfig(result)
    form.value.api_key = ''
    await Promise.all([
      modelsStore.fetchProviders(),
      appStore.reloadModels({ preserveSelection: true }),
    ])
    message.success(t('settings.models.sensenova.saveSuccess'))
  } catch (error: any) {
    message.error(error?.message || t('settings.models.sensenova.saveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(() => { void load() })
</script>

<template>
  <section class="sensenova-section">
    <div class="sensenova-header">
      <div>
        <div class="sensenova-title-row">
          <h3>{{ t('settings.models.sensenova.title') }}</h3>
          <NTag v-if="configured" type="success" size="small" round>
            {{ t('settings.models.sensenova.configured') }}
          </NTag>
          <NTag v-else type="warning" size="small" round>
            {{ t('settings.models.sensenova.notConfigured') }}
          </NTag>
        </div>
        <p>{{ t('settings.models.sensenova.description') }}</p>
      </div>
    </div>

    <NSpin :show="loading">
      <NForm label-placement="top" class="sensenova-form">
        <NFormItem :label="t('settings.models.sensenova.endpoint')">
          <NInput
            v-model:value="form.base_url"
            :placeholder="t('settings.models.sensenova.endpointPlaceholder')"
            autocomplete="url"
          />
        </NFormItem>
        <NFormItem :label="t('settings.models.sensenova.apiKey')">
          <NInput
            v-model:value="form.api_key"
            type="password"
            show-password-on="click"
            :placeholder="keyPlaceholder"
            autocomplete="new-password"
          />
          <div class="sensenova-field-hint">{{ t('settings.models.sensenova.keyHint') }}</div>
        </NFormItem>
        <NFormItem :label="t('settings.models.sensenova.model')">
          <NSelect
            v-model:value="form.model"
            :options="modelOptions"
            filterable
            tag
            :placeholder="t('settings.models.sensenova.modelPlaceholder')"
          />
        </NFormItem>
      </NForm>

      <NAlert v-if="lastTestOk === true" type="success" :bordered="false" class="sensenova-status">
        {{ t('settings.models.sensenova.testReady') }}
      </NAlert>
      <NAlert v-else-if="lastTestOk === false" type="error" :bordered="false" class="sensenova-status">
        {{ t('settings.models.sensenova.testFailed') }}
      </NAlert>

      <div class="sensenova-actions">
        <NButton :loading="testing" @click="testConnection">
          {{ t('settings.models.sensenova.test') }}
        </NButton>
        <NButton type="primary" :loading="saving" @click="save">
          {{ t('settings.models.sensenova.save') }}
        </NButton>
      </div>
    </NSpin>
  </section>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.sensenova-section {
  margin: 0 0 20px;
  padding: 18px;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
}

.sensenova-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 14px;
}

.sensenova-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sensenova-title-row h3 {
  margin: 0;
  color: $text-primary;
  font-size: 16px;
}

.sensenova-header p {
  margin: 6px 0 0;
  color: $text-secondary;
  font-size: 13px;
}

.sensenova-form {
  max-width: 720px;
}

.sensenova-field-hint {
  margin-top: 5px;
  color: $text-secondary;
  font-size: 12px;
}

.sensenova-status {
  margin-top: 4px;
}

.sensenova-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

@media (max-width: 640px) {
  .sensenova-section { padding: 14px; }
  .sensenova-actions { justify-content: stretch; }
  .sensenova-actions :deep(.n-button) { flex: 1; }
}
</style>
