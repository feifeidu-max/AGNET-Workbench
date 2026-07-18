import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const memoryFixture = {
  memory: '# Stable preferences\n\nKeep answers concise.',
  user: '# User profile\n\nLocal research user.',
  soul: '# Soul\n\nBe precise and evidence-led.',
  memory_mtime: 1_789_000_000_000,
  user_mtime: 1_789_000_000_000,
  soul_mtime: 1_789_000_000_000,
  memory_path: 'C:\\Users\\playwright\\.hermes\\profiles\\research\\memories\\MEMORY.md',
  user_path: 'C:\\Users\\playwright\\.hermes\\profiles\\research\\memories\\USER.md',
  soul_path: 'C:\\Users\\playwright\\.hermes\\profiles\\research\\SOUL.md',
  memory_revision: 12,
  user_revision: 7,
  soul_revision: 4,
  character_budget: { max_chars: 20_000, memory: 48, user: 37, soul: 40 },
  effective_status: {
    memory_enabled: true,
    user_profile_enabled: true,
    soul_always_loaded: true,
    clean_mode_excludes_profile_files: true,
  },
}

const knowledgeWorkspaceFixture = {
  service: {
    status: 'running',
    version: '0.6.4',
    retrievalMode: 'keyword_graph',
    llmConfigured: false,
    llmConfigSource: null,
  },
  projects: [{
    id: 'research-wiki',
    name: 'Research Wiki',
    path: 'C:\\Users\\playwright\\Documents\\LLM-Wiki',
    current: true,
  }],
  currentProject: {
    id: 'research-wiki',
    name: 'Research Wiki',
    path: 'C:\\Users\\playwright\\Documents\\LLM-Wiki',
    current: true,
  },
}

for (const viewport of [{ width: 375, height: 667 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}px mobile shell keeps persisted-collapsed navigation readable and memory actions reachable`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    await page.addInitScript(() => {
      window.localStorage.setItem('hermes_sidebar_collapsed', '1')
    })
    const api = await mockHermesApi(page, { memory: memoryFixture })
    await page.route('**/api/knowledge/drafts', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ drafts: [] }),
    }))
    await page.route('**/api/knowledge/workspace', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(knowledgeWorkspaceFixture),
    }))

    await page.goto('/#/hermes/memory')
    await expect(page.locator('.memory-section')).toHaveCount(3)

    const firstSection = page.locator('.memory-section').first()
    const actionButtons = firstSection.locator('.section-header-actions button')
    await expect(actionButtons).toHaveCount(3)
    for (let index = 0; index < 3; index += 1) {
      await expect(actionButtons.nth(index)).toBeVisible()
      await expect(actionButtons.nth(index)).toBeInViewport()
    }

    const sectionBox = await firstSection.boundingBox()
    expect(sectionBox).not.toBeNull()
    for (let index = 0; index < 3; index += 1) {
      const buttonBox = await actionButtons.nth(index).boundingBox()
      expect(buttonBox).not.toBeNull()
      expect(buttonBox!.x).toBeGreaterThanOrEqual(sectionBox!.x)
      expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(sectionBox!.x + sectionBox!.width + 1)
    }

    await actionButtons.nth(2).click()
    await expect(firstSection.locator('.edit-textarea')).toBeVisible()
    await expect(firstSection.getByRole('button', { name: 'Save' })).toBeVisible()

    const memoryOverflow = await page.locator('.memory-content').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }))
    expect(memoryOverflow.scrollWidth).toBeLessThanOrEqual(memoryOverflow.clientWidth)
    expect(memoryOverflow.scrollHeight).toBeGreaterThan(memoryOverflow.clientHeight)
    expect(memoryOverflow.overflowY).toBe('auto')

    await page.locator('.hamburger-btn').click()
    const sidebar = page.locator('aside.sidebar')
    await expect(sidebar).toHaveCSS('width', '240px')
    for (const label of ['个人工作台', 'Hermes 对话', 'LLM Wiki', '公司数据', '定时报告', '记忆管理']) {
      await expect(sidebar.locator('.primary-nav-item span', { hasText: label })).toBeVisible()
    }

    const llmWikiLink = sidebar.locator('.primary-nav-item', { hasText: 'LLM Wiki' })
    await expect(llmWikiLink).toHaveAttribute('href', /#\/hermes\/knowledge\?tab=management/)
    await llmWikiLink.click()
    await expect(page).toHaveURL(/#\/hermes\/knowledge\?tab=management/)
    await expect(page.getByRole('heading', { name: 'LLM Wiki 管理' })).toBeVisible()
    await expect(page.locator('.n-tabs-tab.n-tabs-tab--active', { hasText: 'LLM Wiki 管理' })).toBeVisible()

    const knowledgeHeader = page.locator('.knowledge-page .page-header')
    const knowledgeTitle = page.getByRole('heading', { name: 'LLM Wiki 管理' })
    const [headerBox, titleBox] = await Promise.all([knowledgeHeader.boundingBox(), knowledgeTitle.boundingBox()])
    expect(headerBox).not.toBeNull()
    expect(titleBox).not.toBeNull()
    expect(titleBox!.width).toBeGreaterThan(200)
    expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(headerBox!.x + headerBox!.width + 1)

    const rootOverflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    expect(rootOverflow.scrollWidth).toBeLessThanOrEqual(rootOverflow.clientWidth)
    expect(api.unexpectedRequests).toEqual([])
  })
}
