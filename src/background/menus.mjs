import Browser from 'webextension-polyfill'
import { defaultConfig, getPreferredLanguageKey, getUserConfig } from '../config/index.mjs'
import { changeLanguage, t } from 'i18next'
import { config as menuConfig } from '../content-script/menu-tools/index.mjs'

const menuId = 'ChatGPTBox-Menu'
let refreshMenuQueue = Promise.resolve()

const onClickMenu = (info, tab) => {
  Browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const currentTab = tabs[0]
    const message = {
      itemId: info.menuItemId.replace(menuId, ''),
      selectionText: info.selectionText,
      useMenuPosition: tab.id === currentTab.id,
    }
    console.debug('menu clicked', message)

    if (defaultConfig.selectionTools.includes(message.itemId)) {
      Browser.tabs.sendMessage(currentTab.id, {
        type: 'CREATE_CHAT',
        data: message,
      })
    } else if (message.itemId in menuConfig) {
      if (menuConfig[message.itemId].action) {
        menuConfig[message.itemId].action(true, tab)
      }

      if (menuConfig[message.itemId].genPrompt) {
        Browser.tabs.sendMessage(currentTab.id, {
          type: 'CREATE_CHAT',
          data: message,
        })
      }
    }
  })
}

const isDuplicateMenuError = (error) => Boolean(error?.message?.includes('duplicate id'))
const isMissingMenuError = (error) =>
  Boolean(
    error?.message?.includes('No such menu item') ||
      error?.message?.includes('Cannot find menu item'),
  )

async function safeCreateMenuItem(options) {
  try {
    await Browser.contextMenus.create(options)
  } catch (error) {
    if (!isDuplicateMenuError(error)) throw error
  }
}

async function executeRefreshMenu() {
  if (Browser.contextMenus.onClicked.hasListener(onClickMenu))
    Browser.contextMenus.onClicked.removeListener(onClickMenu)

  try {
    await Browser.contextMenus.removeAll()
  } catch (error) {
    if (!isMissingMenuError(error)) throw error
  }

  const config = await getUserConfig()
  if (config.hideContextMenu) return

  const lang = await getPreferredLanguageKey()
  await changeLanguage(lang)

  await safeCreateMenuItem({
    id: menuId,
    title: 'ChatGPTBox',
    contexts: ['all'],
  })

  for (const [key, value] of Object.entries(menuConfig)) {
    await safeCreateMenuItem({
      id: menuId + key,
      parentId: menuId,
      title: t(value.label),
      contexts: ['all'],
    })
  }

  await safeCreateMenuItem({
    id: menuId + 'separator1',
    parentId: menuId,
    contexts: ['selection'],
    type: 'separator',
  })

  for (let index = 0; index < defaultConfig.selectionTools.length; index += 1) {
    const key = defaultConfig.selectionTools[index]
    const desc = defaultConfig.selectionToolsDesc[index]
    await safeCreateMenuItem({
      id: menuId + key,
      parentId: menuId,
      title: t(desc),
      contexts: ['selection'],
    })
  }

  Browser.contextMenus.onClicked.addListener(onClickMenu)
}

export function refreshMenu() {
  refreshMenuQueue = refreshMenuQueue
    .then(() => executeRefreshMenu())
    .catch((error) => {
      console.error('Failed to refresh context menu', error)
    })
  return refreshMenuQueue
}
