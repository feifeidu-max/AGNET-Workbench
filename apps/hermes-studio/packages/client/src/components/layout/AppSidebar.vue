<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { NModal } from "naive-ui";
import { useAppStore } from "@/stores/hermes/app";
import { usePersistentRecord } from '@/composables/usePersistentRecord'
import RouteLinkItem from '@/components/common/RouteLinkItem.vue'
import ModelSelector from "@/components/layout/ModelSelector.vue";
import ProfileSelector from "@/components/layout/ProfileSelector.vue";
import LanguageSwitch from "@/components/layout/LanguageSwitch.vue";
import { getStoredUsername, isStoredSuperAdmin, isAuthOpenMode } from "@/api/client";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const selectedKey = computed(() => {
  return route.name as string;
});
const isConversationRoute = computed(() => [
  'hermes.chat',
  'hermes.session',
  'hermes.history',
  'hermes.historySession',
  'hermes.groupChat',
  'hermes.groupChatRoom',
].includes(selectedKey.value));
const isSuperAdmin = computed(() => isStoredSuperAdmin());
const currentUsername = computed(() => getStoredUsername());
const isVersionPreview = import.meta.env.VITE_HERMES_PREVIEW === '1';
const showAdvancedTools = ref(false);

const advancedRouteNames = new Set([
  'hermes.jobs',
  'hermes.kanban',
  'hermes.channels',
  'hermes.skills',
  'hermes.plugins',
  'hermes.mcp',
  'hermes.petdex',
  'hermes.models',
  'hermes.logs',
  'hermes.usage',
  'hermes.performance',
  'hermes.journey',
  'hermes.skillsUsage',
  'hermes.codingAgents',
  'hermes.versionPreview',
  'hermes.devices',
  'hermes.profiles',
  'hermes.settings',
]);

const isAdvancedRoute = computed(() => advancedRouteNames.has(selectedKey.value));

function hasRoute(name: string): boolean {
  return router.hasRoute(name);
}
const { record: collapsedGroups, persist: persistCollapsedGroups } = usePersistentRecord('hermes.sidebar.collapsedGroups');

type SidebarGroupKey = "Agent" | "Monitoring" | "Tools" | "System";

function groupLabel(key: SidebarGroupKey) {
  return t(`sidebar.group${key}${appStore.sidebarCollapsed ? "Short" : ""}`);
}

function toggleGroup(key: string) {
  collapsedGroups[key] = !collapsedGroups[key];
  persistCollapsedGroups();
}

function isGroupCollapsed(key: string) {
  return !!collapsedGroups[key];
}

function handleSidebarClick(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null;

  if (!target?.closest(".route-link-item")) {
    return;
  }

  if (typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches) {
    appStore.closeSidebar();
  }
}

function handleLogout() {
  localStorage.clear();
  window.location.reload();
}

function openAdvancedTools() {
  showAdvancedTools.value = true;
}

function handleAdvancedNavigation(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null;

  if (target?.closest('.route-link-item')) {
    showAdvancedTools.value = false;

    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
      appStore.closeSidebar();
    }
  }
}

</script>

<template>
  <aside class="sidebar" :class="{ open: appStore.sidebarOpen, collapsed: appStore.sidebarCollapsed }" @click="handleSidebarClick">
    <nav class="sidebar-nav">
      <div class="primary-nav" aria-label="常用功能">
        <RouteLinkItem class="nav-item primary-nav-item" :to="{ name: 'hermes.workbench' }" :active="selectedKey === 'hermes.workbench'" title="数据知识库">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          <span>数据知识库</span>
        </RouteLinkItem>
        <RouteLinkItem class="nav-item primary-nav-item" :to="{ name: 'hermes.personalWorkbench' }" :active="selectedKey === 'hermes.personalWorkbench'" title="个人工作台">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 4h6v6H4z" /><path d="M14 4h6v6h-6z" /><path d="M4 14h6v6H4z" /><path d="M14 14h6v6h-6z" />
          </svg>
          <span>个人工作台</span>
        </RouteLinkItem>
        <RouteLinkItem class="nav-item primary-nav-item" :to="{ name: 'hermes.chat' }" :active="isConversationRoute" title="Hermes 对话">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>Hermes 对话</span>
        </RouteLinkItem>
        <RouteLinkItem class="nav-item primary-nav-item" :to="{ name: 'hermes.knowledge', query: { tab: 'management' } }" :active="selectedKey === 'hermes.knowledge'" title="LLM Wiki 管理">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
          <span>LLM Wiki</span>
        </RouteLinkItem>
        <RouteLinkItem class="nav-item primary-nav-item" :to="{ name: 'hermes.memory' }" :active="selectedKey === 'hermes.memory'" title="记忆管理">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 18h6" /><path d="M10 22h4" /><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
          </svg>
          <span>记忆管理</span>
        </RouteLinkItem>
      </div>

      <button
        class="nav-item advanced-tools-trigger"
        :class="{ active: isAdvancedRoute }"
        type="button"
        :title="t('sidebar.groupTools')"
        @click="openAdvancedTools"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 6h16" />
          <path d="M4 12h16" />
          <path d="M4 18h16" />
          <circle cx="8" cy="6" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="16" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="10" cy="18" r="1.5" fill="currentColor" stroke="none" />
        </svg>
        <span>{{ t('sidebar.groupTools') }}</span>
      </button>

      <NModal
        v-model:show="showAdvancedTools"
        preset="card"
        :title="t('sidebar.groupTools')"
        style="width: min(560px, calc(100vw - 32px));"
      >
        <div class="advanced-tools-modal-content" @click="handleAdvancedNavigation">
          <div class="advanced-nav nav-group">
            <div class="advanced-nav-groups">
      <!-- Agent -->
      <div class="nav-group">
        <div class="nav-group-label" @click="toggleGroup('agent')">
          <span>{{ groupLabel("Agent") }}</span>
          <svg class="nav-group-arrow" :class="{ collapsed: isGroupCollapsed('agent') }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
        <div v-show="!isGroupCollapsed('agent')" class="nav-group-items">
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.jobs' }" :active="selectedKey === 'hermes.jobs'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
            <span>{{ t("sidebar.jobs") }}</span>
          </RouteLinkItem>
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.kanban' }" :active="selectedKey === 'hermes.kanban'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="5" height="18" rx="1" />
              <rect x="10" y="3" width="5" height="12" rx="1" />
              <rect x="17" y="3" width="5" height="18" rx="1" />
            </svg>
            <span>{{ t("sidebar.kanban") }}</span>
          </RouteLinkItem>
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.channels' }" :active="selectedKey === 'hermes.channels'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            <span>{{ t("sidebar.channels") }}</span>
          </RouteLinkItem>
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.skills' }" :active="selectedKey === 'hermes.skills'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            <span>{{ t("sidebar.skills") }}</span>
          </RouteLinkItem>
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.plugins' }" :active="selectedKey === 'hermes.plugins'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l2.1-2.1a4 4 0 0 1-5.3 5.3l-7.8 7.8a2.1 2.1 0 0 1-3-3l7.8-7.8a4 4 0 0 1 5.3-5.3l-2.1 2.1z" />
              <path d="M5 19l1-1" />
            </svg>
            <span>{{ t("sidebar.plugins") }}</span>
          </RouteLinkItem>
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.mcp' }" :active="selectedKey === 'hermes.mcp'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 7V4h16v3" />
              <path d="M9 20h6" />
              <path d="M12 7v13" />
              <rect x="4" y="7" width="16" height="7" rx="2" />
            </svg>
            <span>{{ t("sidebar.mcp") }}</span>
          </RouteLinkItem>
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.petdex' }" :active="selectedKey === 'hermes.petdex'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3l7 4v6c0 4-3 7-7 8-4-1-7-4-7-8V7l7-4z" />
              <path d="M9 11h.01" />
              <path d="M15 11h.01" />
              <path d="M9.5 15c1.6 1.1 3.4 1.1 5 0" />
            </svg>
            <span>{{ t("sidebar.petdex") }}</span>
          </RouteLinkItem>
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.models' }" :active="selectedKey === 'hermes.models'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4" />
              <path d="M12 19v4" />
              <path d="M1 12h4" />
              <path d="M19 12h4" />
              <path d="M4.22 4.22l2.83 2.83" />
              <path d="M16.95 16.95l2.83 2.83" />
              <path d="M4.22 19.78l2.83-2.83" />
              <path d="M16.95 7.05l2.83-2.83" />
            </svg>
            <span>{{ t("sidebar.models") }}</span>
          </RouteLinkItem>
        </div>
      </div>

      <!-- Monitoring -->
      <div class="nav-group">
        <div class="nav-group-label" @click="toggleGroup('monitoring')">
          <span>{{ groupLabel("Monitoring") }}</span>
          <svg class="nav-group-arrow" :class="{ collapsed: isGroupCollapsed('monitoring') }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
        <div v-show="!isGroupCollapsed('monitoring')" class="nav-group-items">
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.logs' }" :active="selectedKey === 'hermes.logs'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <span>{{ t("sidebar.logs") }}</span>
          </RouteLinkItem>
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.usage' }" :active="selectedKey === 'hermes.usage'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="12" width="4" height="9" rx="1" />
              <rect x="10" y="7" width="4" height="14" rx="1" />
              <rect x="17" y="3" width="4" height="18" rx="1" />
            </svg>
            <span>{{ t("sidebar.usage") }}</span>
          </RouteLinkItem>
          <RouteLinkItem v-if="isSuperAdmin" class="nav-item" :to="{ name: 'hermes.performance' }" :active="selectedKey === 'hermes.performance'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            <span>{{ t("sidebar.performance") }}</span>
          </RouteLinkItem>
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.journey' }" :active="selectedKey === 'hermes.journey'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
              <path d="M4.4 15.4c3.2 1.1 7.4.4 10.8-2.1 3.1-2.3 4.9-5.5 4.5-8.1" />
              <path d="M6.3 6.6c2.5-.9 6.1-.4 9.2 1.5 3.2 2 5.2 5 5 7.6" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
              <circle cx="19.5" cy="4.5" r="1.2" fill="currentColor" stroke="none" />
            </svg>
            <span>{{ t("sidebar.journey") }}</span>
          </RouteLinkItem>
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.skillsUsage' }" :active="selectedKey === 'hermes.skillsUsage'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.21 15.89A10 10 0 1 1 8.11 2.79" />
              <path d="M22 12A10 10 0 0 0 12 2v10z" />
            </svg>
            <span>{{ t("sidebar.skillsUsage") }}</span>
          </RouteLinkItem>
        </div>
      </div>

      <!-- Tools -->
      <div class="nav-group">
        <div class="nav-group-label" @click="toggleGroup('tools')">
          <span>{{ groupLabel("Tools") }}</span>
          <svg class="nav-group-arrow" :class="{ collapsed: isGroupCollapsed('tools') }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
        <div v-show="!isGroupCollapsed('tools')" class="nav-group-items">
          <RouteLinkItem v-if="hasRoute('hermes.codingAgents')" class="nav-item" :to="{ name: 'hermes.codingAgents' }" :active="selectedKey === 'hermes.codingAgents'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
              <line x1="12" y1="20" x2="14" y2="4" />
            </svg>
            <span>{{ t("sidebar.codingAgents") }}</span>
          </RouteLinkItem>
          <RouteLinkItem v-if="hasRoute('hermes.versionPreview') && isSuperAdmin && !isVersionPreview" class="nav-item" :to="{ name: 'hermes.versionPreview' }" :active="selectedKey === 'hermes.versionPreview'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
              <polyline points="7.5 19.79 7.5 14.6 3 12" />
              <polyline points="21 12 16.5 14.6 16.5 19.79" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
            <span>{{ t("sidebar.versionPreview") }}</span>
          </RouteLinkItem>
          <RouteLinkItem v-if="isSuperAdmin" class="nav-item" :to="{ name: 'hermes.devices' }" :active="selectedKey === 'hermes.devices'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="12" rx="2" />
              <path d="M8 20h8" />
              <path d="M12 16v4" />
              <path d="M6 8h.01" />
              <path d="M10 8h.01" />
            </svg>
            <span>{{ t("sidebar.devices") }}</span>
          </RouteLinkItem>
        </div>
      </div>

      <!-- System -->
      <div class="nav-group">
        <div class="nav-group-label" @click="toggleGroup('system')">
          <span>{{ groupLabel("System") }}</span>
          <svg class="nav-group-arrow" :class="{ collapsed: isGroupCollapsed('system') }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
        <div v-show="!isGroupCollapsed('system')" class="nav-group-items">
          <RouteLinkItem v-if="isSuperAdmin" class="nav-item" :to="{ name: 'hermes.profiles' }" :active="selectedKey === 'hermes.profiles'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span>{{ t("sidebar.profiles") }}</span>
          </RouteLinkItem>
          <RouteLinkItem class="nav-item" :to="{ name: 'hermes.settings' }" :active="selectedKey === 'hermes.settings'">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>{{ t("sidebar.settings") }}</span>
          </RouteLinkItem>
        </div>
      </div>
        </div>
        </div>
        </div>
      </NModal>
    </nav>

    <ProfileSelector />
    <ModelSelector />

    <div class="sidebar-footer">
      <button v-if="!isAuthOpenMode()" class="nav-item logout-item" @click="handleLogout">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <polyline points="16 17 21 12 16 7" />
          <line x1="21" y1="12" x2="9" y2="12" />
        </svg>
        <span>{{ t("sidebar.logout") }}</span>
        <span v-if="currentUsername" class="logout-username" :title="currentUsername">{{ currentUsername }}</span>
      </button>
      <div class="status-row">
        <div
          class="status-indicator"
          :class="{
            connected: appStore.connected,
            disconnected: !appStore.connected,
          }"
        >
          <span class="status-dot"></span>
          <span class="status-text">{{
            appStore.connected
              ? t("sidebar.connected")
              : t("sidebar.disconnected")
          }}</span>
        </div>
        <LanguageSwitch />
      </div>
    </div>

    <div class="sidebar-top-actions">
      <RouteLinkItem class="nav-item sidebar-return-tab" :to="{ name: 'hermes.chat' }" :title="t('sidebar.backToChat')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 18 9 12 15 6" />
          <line x1="9" y1="12" x2="21" y2="12" />
        </svg>
        <span>{{ t("sidebar.backToChat") }}</span>
      </RouteLinkItem>
      <button class="collapse-btn" @click="appStore.toggleSidebarCollapsed()" :title="appStore.sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline v-if="appStore.sidebarCollapsed" points="9 18 15 12 9 6" />
          <polyline v-else points="15 18 9 12 15 6" />
        </svg>
      </button>
    </div>

  </aside>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.sidebar {
  position: relative;
  width: $sidebar-width;
  height: calc(100 * var(--vh));
  background-color: $bg-sidebar;
  border-right: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  padding: 8px 12px 20px;
  flex-shrink: 0;
  transition: width $transition-normal;
}

.sidebar-nav {
  flex: 1;
  display: flex;
  padding-top: 8px;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.primary-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 8px;
  border-bottom: 1px solid $border-color;
}

.primary-nav-item {
  font-weight: 500;
}

.advanced-tools-trigger {
  margin-top: 2px;
  flex-shrink: 0;
}

.advanced-tools-modal-content {
  max-height: min(70vh, 680px);
  overflow-y: auto;
  padding: 4px 0;

  .advanced-nav {
    margin-top: 0;
  }
}

.advanced-nav {
  margin-top: 2px;
}

.advanced-nav-groups {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.advanced-nav-groups > .nav-group {
  padding-left: 4px;
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;

  &.nav-group-bottom {
    margin-top: auto;
    padding-top: 8px;
    border-top: 1px solid $border-color;
  }
}

.nav-group-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-group-label {
  font-size: 10px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  padding: 8px 12px 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
  border-radius: $radius-sm;
  transition: color $transition-fast;

  &:hover {
    color: $text-secondary;
  }

  .nav-group:first-child & {
    padding-top: 0;
  }
}

.nav-group-arrow {
  transition: transform $transition-fast;
  flex-shrink: 0;

  &.collapsed {
    transform: rotate(-90deg);
  }
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: none;
  background: none;
  appearance: none;
  text-decoration: none;
  color: $text-secondary;
  font-size: 14px;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all $transition-fast;
  width: 100%;
  text-align: left;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &.active {
    background-color: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  .beta-tag {
    font-size: 10px;
    color: $text-muted;
    margin-left: 2px;
  }
}

.sidebar-top-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid $border-color;
}

.sidebar-return-tab {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  font-size: 13px;
}

.sidebar-footer {
  padding-top: 10px;
  border-top: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.logout-item {
  color: $text-secondary;

  &:hover {
    color: $error;
  }

  > span:not(.logout-username) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.logout-username {
  margin-left: auto;
  max-width: 96px;
  color: $text-muted;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0 4px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding-left: 12px;
  font-size: 12px;
  color: $text-secondary;

  &.connected .status-dot {
    background-color: $success;
    box-shadow: 0 0 6px rgba(var(--success-rgb), 0.5);
  }

  &.disconnected .status-dot {
    background-color: $error;
  }
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// ─── Collapsed sidebar (icon-rail mode) ─────────────────────────

@media (min-width: $breakpoint-mobile + 1px) {
  .sidebar.collapsed {
    width: $sidebar-collapsed-width;
    padding: 8px 8px 12px;
    overflow: hidden;

    .collapse-btn {
      display: flex;
      margin: 0;
    }

    .sidebar-top-actions {
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
      padding-top: 8px;
    }

    .sidebar-return-tab {
      width: 100%;
      flex: 0 0 auto;
      padding: 10px 4px;
    }

    .nav-group-label {
      justify-content: center;
      gap: 2px;
      padding: 8px 0 4px;
      letter-spacing: 0;

      span {
        max-width: 36px;
        overflow: hidden;
        text-align: center;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    .nav-item {
      justify-content: center;
      padding: 10px 4px;
      gap: 0;

      span {
        display: none;
      }

      svg {
        flex-shrink: 0;
      }
    }

    :deep(.model-selector) {
      display: none;
    }

    :deep(.profile-selector) {
      display: flex;
      justify-content: center;
      padding: 8px 0;
    }

    :deep(.profile-selector .selector-label),
    :deep(.profile-selector .profile-name) {
      display: none;
    }

    :deep(.profile-selector .profile-display) {
      width: 40px;
      justify-content: center;
      padding: 4px;
    }

    .sidebar-footer {
      align-items: center;
      gap: 6px;
      padding-top: 8px;
    }

    .status-row {
      display: none;
    }

  }
}

// ─── Collapse button ────────────────────────────────────────────

.collapse-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: none;
  appearance: none;
  text-decoration: none;
  color: $text-muted;
  border-radius: $radius-sm;
  cursor: pointer;
  flex-shrink: 0;
  margin: 0;
  transition: all $transition-fast;

  &:hover {
    color: $text-primary;
    background-color: rgba(var(--accent-primary-rgb), 0.08);
  }
}

@media (max-width: $breakpoint-mobile) {
  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 1000;
    transform: translateX(-100%);
    transition: transform $transition-normal;
    padding-top: env(safe-area-inset-top, 0px);

    &.open {
      transform: translateX(0);
    }

    .collapse-btn {
      display: flex;
    }

    // Override global utility — sidebar is always 240px wide
    .input-sm {
      width: 90px;
    }
  }
}

</style>
