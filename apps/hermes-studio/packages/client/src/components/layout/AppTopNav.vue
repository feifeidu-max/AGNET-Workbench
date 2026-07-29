<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { getStoredUsername, isStoredSuperAdmin } from '@/api/client'

const route = useRoute()
const router = useRouter()

const navItems = [
  { label: '首页', name: 'hermes.paperhub' },
  { label: '工作台', name: 'hermes.workbench' },
  { label: '知识库', name: 'hermes.knowledge' },
  { label: '任务', name: 'hermes.jobs' },
  { label: '对话', name: 'hermes.chat' },
  { label: '历史', name: 'hermes.history' },
  { label: '设置', name: 'hermes.settings' },
]

const currentName = computed(() => route.name as string)
const activeName = computed(() => {
  // personal-workbench 与 workbench 都归到“工作台”高亮
  if (currentName.value === 'hermes.personalWorkbench') return 'hermes.workbench'
  return currentName.value
})

const mobileOpen = ref(false)
function toggleMobile() {
  mobileOpen.value = !mobileOpen.value
}
function closeMobile() {
  mobileOpen.value = false
}

const searchQuery = ref('')
function runSearch() {
  const q = searchQuery.value.trim()
  closeMobile()
  if (!q) {
    router.push({ name: 'hermes.paperhub' })
    return
  }
  router.push({ name: 'hermes.paperhub', query: { q } })
}

const username = computed(() => getStoredUsername())
const isAdmin = computed(() => isStoredSuperAdmin())
function goSettings() {
  closeMobile()
  router.push({ name: 'hermes.settings' })
}
</script>

<template>
  <header class="ph-topnav">
    <div class="ph-nav-left">
      <RouterLink class="ph-logo" :to="{ name: 'hermes.paperhub' }" @click="closeMobile">PaperHub</RouterLink>
      <nav class="ph-nav-links" :class="{ open: mobileOpen }">
        <RouterLink
          v-for="item in navItems"
          :key="item.name"
          class="ph-nav-link"
          :class="{ active: activeName === item.name }"
          :to="{ name: item.name }"
          @click="closeMobile"
        >{{ item.label }}</RouterLink>
      </nav>
    </div>

    <div class="ph-nav-right">
      <div class="ph-nav-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="11" cy="11" r="7" stroke="#999999" stroke-width="2" />
          <path d="M16 16L20 20" stroke="#999999" stroke-width="2" stroke-linecap="round" />
        </svg>
        <input
          v-model="searchQuery"
          type="text"
          placeholder="搜索论文…"
          @keyup.enter="runSearch"
        />
      </div>
      <button class="ph-nav-login" @click="goSettings">
        {{ isAdmin || username ? (username || '管理员') : '登录' }}
      </button>
      <button class="ph-hamburger" aria-label="菜单" @click="toggleMobile">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1A1A1A" stroke-width="2" stroke-linecap="round">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped lang="scss">
.ph-topnav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 64px;
  padding: 0 48px;
  background: var(--ph-card);
  border-bottom: 1px solid var(--ph-border);
  flex: 0 0 auto;
  font-family: var(--ph-font-sans);
}

.ph-nav-left {
  display: flex;
  align-items: center;
  gap: 40px;
}

.ph-logo {
  font-family: var(--ph-font-serif);
  font-size: 22px;
  font-weight: 600;
  color: var(--ph-navy);
  white-space: nowrap;
}

.ph-nav-links {
  display: flex;
  align-items: center;
  gap: 28px;
}

.ph-nav-link {
  font-size: 14px;
  font-weight: 500;
  color: var(--ph-text-medium);
  transition: color 0.2s;
  white-space: nowrap;

  &:hover,
  &.active {
    color: var(--ph-navy);
  }
}

.ph-nav-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

.ph-nav-search {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 220px;
  height: 36px;
  padding: 0 12px;
  background: var(--ph-bg);
  border: 1px solid var(--ph-border);
  border-radius: 8px;

  input {
    flex: 1;
    border: none;
    background: none;
    outline: none;
    font-family: var(--ph-font-sans);
    font-size: 13px;
    color: var(--ph-text-dark);

    &::placeholder {
      color: var(--ph-text-light);
    }
  }
}

.ph-nav-login {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  padding: 0 20px;
  background: var(--ph-navy);
  border: none;
  border-radius: 8px;
  color: #fff;
  font-family: var(--ph-font-sans);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.2s;
  white-space: nowrap;

  &:hover {
    opacity: 0.9;
  }
}

.ph-hamburger {
  display: none;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: none;
  border: 1px solid var(--ph-border);
  border-radius: 8px;
  cursor: pointer;
}

@media (max-width: 980px) {
  .ph-topnav {
    padding: 0 20px;
  }

  .ph-hamburger {
    display: flex;
  }

  .ph-nav-links {
    position: absolute;
    top: 64px;
    left: 0;
    right: 0;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 12px 20px;
    background: var(--ph-card);
    border-bottom: 1px solid var(--ph-border);
    box-shadow: 0 8px 24px rgba(6, 8, 10, 0.08);
    display: none;
    z-index: 50;

    &.open {
      display: flex;
    }
  }

  .ph-nav-link {
    width: 100%;
    padding: 8px 0;
  }

  .ph-nav-search {
    width: 150px;
  }
}

@media (max-width: 560px) {
  .ph-nav-search {
    display: none;
  }
}
</style>
