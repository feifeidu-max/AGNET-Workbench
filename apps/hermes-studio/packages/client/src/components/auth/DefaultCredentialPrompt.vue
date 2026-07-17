<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { NButton, NModal } from "naive-ui";
import { fetchCurrentUser } from "@/api/auth";
import { getApiKey } from "@/api/client";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const show = ref(false);
const loading = ref(false);

function isDesktopShell(): boolean {
  return (window as typeof window & { hermesDesktop?: { isDesktop?: boolean } }).hermesDesktop?.isDesktop === true;
}

async function checkDefaultCredentials() {
  if (isDesktopShell()) {
    show.value = false;
    return;
  }

  if (route.name === "login") {
    show.value = false;
    return;
  }

  const token = getApiKey();
  if (!token) return;

  loading.value = true;
  try {
    const user = await fetchCurrentUser();
    const isAccountSettings = route.name === "hermes.settings" && route.query.tab === "account";
    show.value = !!user.requiresCredentialChange && !isAccountSettings;
  } catch {
    show.value = false;
  } finally {
    loading.value = false;
  }
}

function goToAccountSettings() {
  show.value = false;
  router.push({ name: "hermes.settings", query: { tab: "account" } });
}

watch(() => route.fullPath, () => {
  void checkDefaultCredentials();
}, { immediate: true });
</script>

<template>
  <NModal
    v-model:show="show"
    preset="dialog"
    :title="t('login.defaultCredentialTitle')"
    :mask-closable="false"
    :closable="false"
  >
    <p class="credential-warning-text">
      {{ t("login.defaultCredentialMessage") }}
    </p>
    <template #action>
      <NButton type="primary" :loading="loading" @click="goToAccountSettings">
        {{ t("login.defaultCredentialAction") }}
      </NButton>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.credential-warning-text {
  margin: 0;
  line-height: 1.6;
}
</style>
