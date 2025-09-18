import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import Browser from 'webextension-polyfill'
import InputBox from '../InputBox'
import ConversationItem from '../ConversationItem'
import {
  apiModeToModelName,
  createElementAtPosition,
  getApiModesFromConfig,
  isApiModeSelected,
  isFirefox,
  isMobile,
  isSafari,
  isUsingModelName,
  modelNameToDesc,
  modelNameToApiMode,
} from '../../utils'
import {
  ArchiveIcon,
  DesktopDownloadIcon,
  LinkExternalIcon,
  MoveToBottomIcon,
  SearchIcon,
} from '@primer/octicons-react'
import { Pin, WindowDesktop, XLg } from 'react-bootstrap-icons'
import FileSaver from 'file-saver'
import { render } from 'preact'
import FloatingToolbar from '../FloatingToolbar'
import { useClampWindowSize } from '../../hooks/use-clamp-window-size'
import { getUserConfig, isUsingBingWebModel } from '../../config/index.mjs'
import { useTranslation } from 'react-i18next'
import DeleteButton from '../DeleteButton'
import { useConfig } from '../../hooks/use-config.mjs'
import { updateSession as updateLocalSession } from '../../services/local-session.mjs'
import { v4 as uuidv4 } from 'uuid'
import { initSession } from '../../services/init-session.mjs'
import { findLastIndex } from 'lodash-es'
import { generateAnswersWithBingWebApi } from '../../services/apis/bing-web.mjs'
import { handlePortError } from '../../services/wrappers.mjs'

const logo = Browser.runtime.getURL('logo.png')

const isApiModeSelectedSafe = (apiMode, configOrSession) => {
  // fallback when the shared helper is unavailable in standalone builds
  if (!apiMode || !configOrSession) return false
  if (typeof isApiModeSelected === 'function') return isApiModeSelected(apiMode, configOrSession)
  const order = (value) => JSON.stringify(value || {}, value ? Object.keys(value).sort() : [])
  if (configOrSession.apiMode) return order(configOrSession.apiMode) === order(apiMode)
  return configOrSession.modelName === apiModeToModelName(apiMode)
}

class ConversationItemData extends Object {
  /**
   * @param {'question'|'answer'|'error'} type
   * @param {string} content
   * @param {boolean} done
   * @param {object|undefined} meta
   */
  constructor(type, content, done = false, meta = undefined) {
    super()
    this.type = type
    this.content = content
    this.done = done
    this.meta = meta
  }
}

function ConversationCard(props) {
  const { t } = useTranslation()
  const [isReady, setIsReady] = useState(!props.question)
  const [port, setPort] = useState(() => Browser.runtime.connect())
  const [triggered, setTriggered] = useState(!props.waitForTrigger)
  const [session, setSession] = useState(props.session)
  const windowSize = useClampWindowSize([750, 1500], [250, 1100])
  const bodyRef = useRef(null)
  const [completeDraggable, setCompleteDraggable] = useState(false)
  const useForegroundFetch = isUsingBingWebModel(session)
  const [apiModes, setApiModes] = useState([])
  const [showPicker, setShowPicker] = useState(false)
  const [selectedTargets, setSelectedTargets] = useState(() => session.targets || [])
  const [fanoutStatuses, setFanoutStatuses] = useState({})
  const fanoutRunRef = useRef(null)

  /**
   * @type {[ConversationItemData[], (conversationItemData: ConversationItemData[]) => void]}
   */
  const [conversationItemData, setConversationItemData] = useState([])
  const config = useConfig()

  const foregroundMessageListeners = useRef([])

  const latestQuestionRef = useRef(props.question || '')
  useLayoutEffect(() => {
    if (session.conversationRecords.length === 0) {
      if (props.question && triggered) {
        setConversationItemData([
          new ConversationItemData(
            'answer',
            `<p class="gpt-loading">${t(`Waiting for response...`)}</p>`,
          ),
        ])
      }
    } else {
      const ret = []
      for (const record of session.conversationRecords) {
        if (record.question) ret.push(new ConversationItemData('question', record.question, true))
        if (record.answer)
          ret.push(new ConversationItemData('answer', record.answer, true, record.meta))
      }
      setConversationItemData(ret)
    }
  }, [])

  useEffect(() => {
    setCompleteDraggable(!isSafari() && !isFirefox() && !isMobile())
  }, [])

  useEffect(() => {
    if (props.onUpdate) props.onUpdate(port, session, conversationItemData)
  }, [session, conversationItemData, props, port])

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const { offsetHeight, scrollHeight, scrollTop } = el
    if (
      config.lockWhenAnswer &&
      scrollHeight <= scrollTop + offsetHeight + config.answerScrollMargin
    )
      el.scrollTo({ top: scrollHeight, behavior: 'instant' })
  }, [conversationItemData, config.lockWhenAnswer, config.answerScrollMargin])

  useEffect(() => {
    const sendInitialQuestion = async () => {
      if (props.question && triggered) {
        latestQuestionRef.current = props.question
        const newSession = initSession({ ...session, question: props.question })
        setSession(newSession)
        await postMessage({ session: newSession })
      }
    }
    sendInitialQuestion()
    // eslint-disable-next-line
  }, [props.question, triggered])

  useLayoutEffect(() => {
    setApiModes(getApiModesFromConfig(config, true))
  }, [
    config.activeApiModes,
    config.customApiModes,
    config.azureDeploymentName,
    config.ollamaModelName,
  ])

  useEffect(() => {
    if (!selectedTargets || selectedTargets.length === 0) {
      const currentIndex = apiModes.findIndex((m) => isApiModeSelectedSafe(m, session))
      if (currentIndex >= 0) {
        const apiMode = apiModes[currentIndex]
        const modelName = apiModeToModelName(apiMode)
        const target = {
          id: modelName,
          apiMode,
          modelName,
          provider: apiMode.groupName,
        }
        setSelectedTargets([target])
        setSession((old) => ({ ...old, targets: [target] }))
      }
    }
  }, [apiModes, selectedTargets, session])

  const updateAnswer = (value, appended, newType, done = false) => {
    setConversationItemData((old) => {
      const copy = [...old]
      const index = findLastIndex(copy, (v) => v.type === 'answer' || v.type === 'error')
      if (index === -1) return copy
      const meta = copy[index].meta
      copy[index] = new ConversationItemData(
        newType,
        appended ? copy[index].content + value : value,
        done,
        meta,
      )
      return copy
    })
  }

  const updateAnswerForTarget = (targetId, updater) => {
    setConversationItemData((old) => {
      const copy = [...old]
      let index = findLastIndex(
        copy,
        (v) => v.type === 'answer' && v.meta && v.meta.sourceTargetId === targetId,
      )
      if (index === -1) {
        const placeholder = new ConversationItemData(
          'answer',
          `<p class="gpt-loading">${t('Waiting for response...')}</p>`,
          false,
          { runId: fanoutRunRef.current, sourceTargetId: targetId },
        )
        copy.push(placeholder)
        index = copy.length - 1
      }
      copy[index] = updater(copy[index])
      return copy
    })
  }

  const storeTargetState = (targetId, partialState) => {
    if (!partialState) return
    setSession((old) => {
      const targetStates = { ...(old.targetStates || {}) }
      targetStates[targetId] = { ...(targetStates[targetId] || {}), ...partialState }
      return { ...old, targetStates }
    })
  }

  const persistSessionSilently = (nextSession) => {
    try {
      updateLocalSession(nextSession)
    } catch (error) {
      /* ignore */
    }
  }
  const fanoutMessageHandler = (msg) => {
    if (!msg.fanout) return false
    const { runId, targetId } = msg.fanout
    if (!fanoutRunRef.current || runId !== fanoutRunRef.current) return true
    if ((fanoutStatuses && fanoutStatuses[targetId]) === 'canceled') return true

    if (msg.session) {
      const providerStateKeys = [
        'conversationId',
        'messageId',
        'parentMessageId',
        'wsRequestId',
        'bingWeb_encryptedConversationSignature',
        'bingWeb_conversationId',
        'bingWeb_clientId',
        'bingWeb_invocationId',
        'bingWeb_jailbreakConversationId',
        'bingWeb_parentMessageId',
        'bingWeb_jailbreakConversationCache',
        'poe_chatId',
        'bard_conversationObj',
        'claude_conversation',
        'moonshot_conversation',
      ]
      const state = {}
      providerStateKeys.forEach((key) => {
        if (key in msg.session) state[key] = msg.session[key]
      })
      storeTargetState(targetId, state)
    }

    if (msg.answer !== undefined) {
      updateAnswerForTarget(
        targetId,
        () =>
          new ConversationItemData('answer', msg.answer, false, {
            runId,
            sourceTargetId: targetId,
          }),
      )
      setFanoutStatuses((old) => ({ ...old, [targetId]: 'running' }))
    }

    if (msg.error) {
      updateAnswerForTarget(
        targetId,
        () =>
          new ConversationItemData('error', t(msg.error), true, {
            runId,
            sourceTargetId: targetId,
          }),
      )
      setFanoutStatuses((old) => ({ ...old, [targetId]: 'error' }))
      setIsReady(true)
    }

    if (msg.done) {
      let finalAnswer = ''
      updateAnswerForTarget(targetId, (item) => {
        finalAnswer = item.content
        return new ConversationItemData(item.type, item.content, true, item.meta)
      })
      setFanoutStatuses((old) => ({ ...old, [targetId]: 'done' }))
      setSession((old) => {
        const answer = finalAnswer || msg.answer || ''
        const updated = {
          ...old,
          conversationRecords: [
            ...(old.conversationRecords || []),
            { question: null, answer, meta: { runId, sourceTargetId: targetId } },
          ],
        }
        persistSessionSilently(updated)
        return updated
      })
      const allDone = (selectedTargets || [])
        .map((target) => fanoutStatuses[target.id] || 'queued')
        .every((status) => status === 'done' || status === 'error')
      if (allDone) setIsReady(true)
    }

    return true
  }

  const portMessageListener = (msg) => {
    if (msg.type === 'FANOUT_START' && msg.fanout?.runId) {
      fanoutRunRef.current = msg.fanout.runId
      const targetIds = msg.fanout.targetIds || []
      setConversationItemData((old) =>
        old.map((item) => {
          if (
            item.type === 'answer' &&
            item.meta &&
            item.meta.runId === 'pending' &&
            (!targetIds.length || targetIds.includes(item.meta.sourceTargetId))
          )
            return new ConversationItemData(item.type, item.content, item.done, {
              ...item.meta,
              runId: msg.fanout.runId,
            })
          return item
        }),
      )
      setFanoutStatuses((old) => {
        const next = { ...old }
        targetIds.forEach((id) => {
          if (!next[id] || next[id] === 'queued') next[id] = 'running'
        })
        return next
      })
      return
    }

    if (msg.type === 'FANOUT_DONE') {
      setIsReady(true)
      persistSessionSilently(session)
      return
    }

    if (fanoutMessageHandler(msg)) return

    if (msg.answer) updateAnswer(msg.answer, false, 'answer')

    if (msg.session) {
      const nextSession = msg.done ? { ...msg.session, isRetry: false } : msg.session
      setSession(nextSession)
    }

    if (msg.done) {
      updateAnswer('', true, 'answer', true)
      setIsReady(true)
    }

    if (msg.error) {
      switch (msg.error) {
        case 'UNAUTHORIZED':
          updateAnswer(
            `${t('UNAUTHORIZED')}<br>${t('Please login at https://chatgpt.com first')}${
              isSafari() ? `<br>${t('Then open https://chatgpt.com/api/auth/session')}` : ''
            }<br>${t('And refresh this page or type you question again')}` +
              `<br><br>${t(
                'Consider creating an api key at https://platform.openai.com/account/api-keys',
              )}`,
            false,
            'error',
          )
          break
        case 'CLOUDFLARE':
          updateAnswer(
            `${t('OpenAI Security Check Required')}<br>${
              isSafari()
                ? t('Please open https://chatgpt.com/api/auth/session')
                : t('Please open https://chatgpt.com')
            }<br>${t('And refresh this page or type you question again')}` +
              `<br><br>${t(
                'Consider creating an api key at https://platform.openai.com/account/api-keys',
              )}`,
            false,
            'error',
          )
          break
        default: {
          let formattedError = msg.error
          if (typeof msg.error === 'string' && msg.error.trimStart().startsWith('{'))
            try {
              formattedError = JSON.stringify(JSON.parse(msg.error), null, 2)
            } catch (error) {
              /* ignore */
            }
          const lastItem = conversationItemData[conversationItemData.length - 1]
          if (lastItem && (lastItem.content.includes('gpt-loading') || lastItem.type === 'error'))
            updateAnswer(t(formattedError), false, 'error')
          else
            setConversationItemData([
              ...conversationItemData,
              new ConversationItemData('error', t(formattedError)),
            ])
          break
        }
      }
      setIsReady(true)
    }
  }
  const postMessage = async ({ session, stop }) => {
    if (useForegroundFetch) {
      foregroundMessageListeners.current.forEach((listener) => listener({ session, stop }))
      if (session) {
        const fakePort = {
          postMessage: (msg) => portMessageListener(msg),
          onMessage: {
            addListener: (listener) => foregroundMessageListeners.current.push(listener),
            removeListener: (listener) => {
              const index = foregroundMessageListeners.current.indexOf(listener)
              if (index !== -1) foregroundMessageListeners.current.splice(index, 1)
            },
          },
          onDisconnect: { addListener: () => {}, removeListener: () => {} },
        }
        try {
          const bingToken = (await getUserConfig()).bingAccessToken
          if (isUsingModelName('bingFreeSydney', session))
            await generateAnswersWithBingWebApi(
              fakePort,
              session.question,
              session,
              bingToken,
              true,
            )
          else await generateAnswersWithBingWebApi(fakePort, session.question, session, bingToken)
        } catch (err) {
          handlePortError(session, fakePort, err)
        }
      }
    } else {
      port.postMessage({ session, stop })
    }
  }

  useEffect(() => {
    const portListener = () => {
      setPort(Browser.runtime.connect())
      setIsReady(true)
    }

    const closeChatsMessageListener = (message) => {
      if (message.type === 'CLOSE_CHATS') {
        port.disconnect()
        Browser.runtime.onMessage.removeListener(closeChatsMessageListener)
        window.removeEventListener('keydown', closeChatsEscListener)
        if (props.onClose) props.onClose()
      }
    }
    const closeChatsEscListener = async (e) => {
      if (e.key === 'Escape' && (await getUserConfig()).allowEscToCloseAll)
        closeChatsMessageListener({ type: 'CLOSE_CHATS' })
    }

    if (props.closeable) {
      Browser.runtime.onMessage.addListener(closeChatsMessageListener)
      window.addEventListener('keydown', closeChatsEscListener)
    }
    port.onDisconnect.addListener(portListener)
    return () => {
      if (props.closeable) {
        Browser.runtime.onMessage.removeListener(closeChatsMessageListener)
        window.removeEventListener('keydown', closeChatsEscListener)
      }
      port.onDisconnect.removeListener(portListener)
    }
  }, [port, props.closeable, props.onClose])

  useEffect(() => {
    if (useForegroundFetch) return () => {}
    port.onMessage.addListener(portMessageListener)
    return () => {
      port.onMessage.removeListener(portMessageListener)
    }
    // eslint-disable-next-line
  }, [conversationItemData])

  const getRetryFn = (retrySession) => async () => {
    updateAnswer(`<p class="gpt-loading">${t('Waiting for response...')}</p>`, false, 'answer')
    setIsReady(false)

    if (retrySession.conversationRecords.length > 0) {
      const lastRecord =
        retrySession.conversationRecords[retrySession.conversationRecords.length - 1]
      if (
        conversationItemData[conversationItemData.length - 1].done &&
        conversationItemData.length > 1 &&
        lastRecord.question === conversationItemData[conversationItemData.length - 2].content
      )
        retrySession.conversationRecords.pop()
    }
    const newSession = { ...retrySession, isRetry: true }
    setSession(newSession)
    try {
      await postMessage({ stop: true })
      await postMessage({ session: newSession })
    } catch (error) {
      updateAnswer(error, false, 'error')
    }
  }

  const getLatestQuestion = () => {
    if (session?.question) return session.question
    const history = session?.conversationRecords || []
    if (history.length > 0) return history[history.length - 1].question
    for (let i = conversationItemData.length - 1; i >= 0; i -= 1)
      if (conversationItemData[i].type === 'question') return conversationItemData[i].content
    return latestQuestionRef.current
  }

  const getRetryTargetFn = (targetId) => async () => {
    const latestQuestion = getLatestQuestion()
    if (!latestQuestion) return

    const runId = uuidv4()
    fanoutRunRef.current = runId

    setConversationItemData((old) => [
      ...old,
      new ConversationItemData(
        'answer',
        `<p class="gpt-loading">${t('Waiting for response...')}</p>`,
        false,
        { runId: 'pending', sourceTargetId: targetId },
      ),
    ])
    setFanoutStatuses((old) => ({ ...old, [targetId]: 'running' }))

    const targetsPool =
      selectedTargets && selectedTargets.length > 0 ? selectedTargets : session.targets || []
    let target = targetsPool.find((tgt) => tgt.id === targetId)
    if (!target)
      target = { id: targetId, apiMode: modelNameToApiMode(targetId), modelName: targetId }

    const newSession = {
      ...session,
      question: latestQuestion,
      isRetry: true,
      lastRunId: runId,
    }

    try {
      port.postMessage({
        fanout: {
          runId,
          fanoutMode: 'parallel',
          targets: [
            {
              id: target.id,
              apiMode: target.apiMode,
              modelName: target.modelName,
            },
          ],
        },
        session: newSession,
      })
    } catch (error) {
      updateAnswer(error, false, 'error')
    }
  }
  const headerButtons = useMemo(() => {
    const renderChips = () => {
      if (!selectedTargets || selectedTargets.length === 0) return null
      if (selectedTargets.length === 1)
        return (
          <span style={{ display: 'inline-flex', gap: '6px' }}>
            <span
              style={{
                padding: '2px 6px',
                border: '1px solid var(--color-border-default, #ccc)',
                borderRadius: '8px',
                fontSize: '12px',
              }}
            >
              {modelNameToDesc(selectedTargets[0].modelName, t, config.customModelName)}
            </span>
          </span>
        )
      return (
        <span style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap' }}>
          {selectedTargets.slice(0, 4).map((target) => (
            <span
              key={target.id}
              style={{
                padding: '2px 6px',
                border: '1px solid var(--color-border-default, #ccc)',
                borderRadius: '8px',
                fontSize: '12px',
                opacity: fanoutStatuses[target.id] === 'done' ? 0.8 : 1,
              }}
              title={fanoutStatuses[target.id] || 'queued'}
            >
              {modelNameToDesc(target.modelName, t, config.customModelName)}
              {(fanoutStatuses[target.id] === 'running' ||
                fanoutStatuses[target.id] === 'queued') && (
                <span
                  style={{ marginLeft: '6px', cursor: 'pointer' }}
                  onClick={() => setFanoutStatuses((old) => ({ ...old, [target.id]: 'canceled' }))}
                >
                  ×
                </span>
              )}
            </span>
          ))}
          {selectedTargets.length > 4 && <span>…</span>}
          {selectedTargets
            .map((target) => fanoutStatuses[target.id] || 'queued')
            .every((status) => status === 'done' || status === 'error') && (
            <button
              type="button"
              className="normal-button"
              onClick={() => {
                const runId = fanoutRunRef.current
                if (!runId) return
                const merged = conversationItemData
                  .filter((item) => item.type === 'answer' && item.meta?.runId === runId)
                  .map((item) => item.content)
                  .join('\n\n---\n\n')
                if (!merged) return
                setConversationItemData((old) => [
                  ...old,
                  new ConversationItemData('answer', merged, true, {
                    runId,
                    mergedFromTargetIds: selectedTargets.map((target) => target.id),
                  }),
                ])
                setSession((old) => {
                  const updated = {
                    ...old,
                    conversationRecords: [
                      ...(old.conversationRecords || []),
                      { question: old.question, answer: merged, meta: { runId } },
                    ],
                  }
                  persistSessionSilently(updated)
                  return updated
                })
              }}
            >
              {t('Merge')}
            </button>
          )}
          <button
            type="button"
            className="normal-button"
            onClick={() => {
              const canceled = {}
              selectedTargets.forEach((target) => {
                canceled[target.id] = 'canceled'
              })
              setFanoutStatuses(canceled)
              fanoutRunRef.current = null
            }}
          >
            {t('Cancel All')}
          </button>
        </span>
      )
    }

    return (
      <>
        <button
          type="button"
          className="normal-button"
          title={t('Choose multiple models')}
          onClick={(event) => {
            event.preventDefault()
            setShowPicker((prev) => !prev)
          }}
        >
          {t('Models')}
          {selectedTargets && selectedTargets.length > 1 ? ` (${selectedTargets.length})` : ''}
        </button>
        {renderChips()}
      </>
    )
  }, [selectedTargets, fanoutStatuses, t, config.customModelName, conversationItemData])

  const renderModelPicker = () => {
    if (!showPicker) return null
    return (
      <div
        style={{
          position: 'absolute',
          top: '48px',
          left: '12px',
          background: 'var(--color-canvas-default, #fff)',
          border: '1px solid var(--color-border-default, #ddd)',
          borderRadius: '8px',
          padding: '8px',
          zIndex: 1000,
          maxHeight: '260px',
          overflowY: 'auto',
          minWidth: '260px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
        }}
      >
        {apiModes.map((apiMode, index) => {
          const modelName = apiModeToModelName(apiMode)
          const label = modelNameToDesc(modelName, t, config.customModelName)
          if (!label) return null
          const checked = !!selectedTargets.find((target) => target.id === modelName)
          return (
            <label key={index} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  setSelectedTargets((prev) => {
                    let next
                    if (event.target.checked) {
                      if (checked) return prev
                      next = [
                        ...prev,
                        {
                          id: modelName,
                          apiMode,
                          modelName,
                          provider: apiMode.groupName,
                        },
                      ]
                    } else next = prev.filter((target) => target.id !== modelName)
                    setSession((old) => ({ ...old, targets: next }))
                    return next
                  })
                }}
              />
              <span>{label}</span>
            </label>
          )
        })}
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span>{t('Mode')}</span>
            <select
              className="normal-button"
              value={session.fanout || 'parallel'}
              onChange={(event) => setSession((old) => ({ ...old, fanout: event.target.value }))}
            >
              <option value="parallel">{t('Parallel')}</option>
              <option value="sequential">{t('Sequential')}</option>
            </select>
          </label>
          <div style={{ flexGrow: 1 }} />
          <button type="button" className="normal-button" onClick={() => setShowPicker(false)}>
            {t('Close')}
          </button>
        </div>
      </div>
    )
  }
  const renderConversationItems = () => {
    const items = []
    const getDescName = (data) => {
      if (data.type !== 'answer') return null
      const sourceId = data?.meta?.sourceTargetId
      if (sourceId) {
        const targetsPool = selectedTargets?.length ? selectedTargets : session.targets || []
        const target = targetsPool.find((tgt) => tgt.id === sourceId)
        if (target) return modelNameToDesc(target.modelName, t, config.customModelName)
      }
      return session.aiName
    }

    for (let i = 0; i < conversationItemData.length; i += 1) {
      const data = conversationItemData[i]
      if (data.type === 'answer' && data.meta?.runId) {
        const runId = data.meta.runId
        const group = []
        let j = i
        while (
          j < conversationItemData.length &&
          conversationItemData[j].type !== 'question' &&
          conversationItemData[j].meta &&
          conversationItemData[j].meta.runId === runId
        ) {
          group.push({ data: conversationItemData[j], index: j })
          j += 1
        }
        group.sort((a, b) => {
          const getIndex = (item) => {
            const id = item.data?.meta?.sourceTargetId
            const idx = (selectedTargets || session.targets || []).findIndex(
              (target) => target.id === id,
            )
            return idx === -1 ? 9999 : idx
          }
          return getIndex(a) - getIndex(b)
        })
        items.push(
          <div
            key={`fanout-${runId}-${i}`}
            className="fanout-grid"
            style={{
              display: 'grid',
              gap: '12px',
              gridTemplateColumns: `repeat(${group.length}, minmax(0, 1fr))`,
            }}
          >
            {group.map(({ data: groupedData, index }) => (
              <div key={`fanout-cell-${runId}-${index}`}>
                <ConversationItem
                  content={groupedData.content}
                  type={groupedData.type}
                  descName={getDescName(groupedData)}
                  onRetry={
                    groupedData?.meta?.sourceTargetId
                      ? getRetryTargetFn(groupedData.meta.sourceTargetId)
                      : getRetryFn(session)
                  }
                />
              </div>
            ))}
          </div>,
        )
        i = j - 1
      } else {
        items.push(
          <ConversationItem
            content={data.content}
            key={i}
            type={data.type}
            descName={data.type === 'answer' ? getDescName(data) : null}
            onRetry={i === conversationItemData.length - 1 ? getRetryFn(session) : null}
          />,
        )
      }
    }

    return items
  }
  return (
    <div className="gpt-inner">
      <div
        className={
          props.draggable ? `gpt-header${completeDraggable ? ' draggable' : ''}` : 'gpt-header'
        }
        style="user-select:none;"
      >
        <span
          className="gpt-util-group"
          style={{
            padding: '15px 0 15px 15px',
            flexGrow: props.notClampSize ? undefined : isMobile() ? 0 : 1,
            maxWidth: isMobile() ? '200px' : undefined,
          }}
        >
          {props.closeable ? (
            <span
              className="gpt-util-icon"
              title={t('Close the Window')}
              onClick={() => {
                port.disconnect()
                if (props.onClose) props.onClose()
              }}
            >
              <XLg size={16} />
            </span>
          ) : props.dockable ? (
            <span
              className="gpt-util-icon"
              title={t('Pin the Window')}
              onClick={() => {
                if (props.onDock) props.onDock()
              }}
            >
              <Pin size={16} />
            </span>
          ) : (
            <img src={logo} style="user-select:none;width:20px;height:20px;" />
          )}
          <span
            className="gpt-util-group"
            style={{ gap: '8px', paddingLeft: '8px', position: 'relative' }}
          >
            {headerButtons}
            {renderModelPicker()}
          </span>
        </span>
        {props.draggable && !completeDraggable && (
          <div className="draggable" style={{ flexGrow: 2, cursor: 'move', height: '55px' }} />
        )}
        <span
          className="gpt-util-group"
          style={{
            padding: '15px 15px 15px 0',
            justifyContent: 'flex-end',
            flexGrow: props.draggable && !completeDraggable ? 0 : 1,
          }}
        >
          {!config.disableWebModeHistory && session?.conversationId && (
            <a
              title={t('Continue on official website')}
              href={`https://chatgpt.com/chat/${session.conversationId}`}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className="gpt-util-icon"
              style="color: inherit;"
            >
              <LinkExternalIcon size={16} />
            </a>
          )}
          <span
            className="gpt-util-icon"
            title={t('Float the Window')}
            onClick={() => {
              const rect = { x: window.innerWidth / 2 - 300, y: window.innerHeight / 2 - 200 }
              const container = createElementAtPosition(rect.x, rect.y)
              container.className = 'chatgptbox-toolbar-container-not-queryable'
              render(
                <FloatingToolbar
                  session={session}
                  selection=""
                  container={container}
                  closeable={true}
                  triggered={true}
                />,
                container,
              )
            }}
          >
            <WindowDesktop size={16} />
          </span>
          <DeleteButton
            size={16}
            text={t('Clear Conversation')}
            onConfirm={async () => {
              await postMessage({ stop: true })
              Browser.runtime.sendMessage({
                type: 'DELETE_CONVERSATION',
                data: {
                  conversationId: session.conversationId,
                },
              })
              setConversationItemData([])
              setFanoutStatuses({})
              fanoutRunRef.current = null
              latestQuestionRef.current = ''
              const resetSession = initSession({
                ...session,
                question: null,
                conversationRecords: [],
                targets: selectedTargets || [],
                targetStates: {},
                runs: [],
                lastRunId: null,
              })
              resetSession.sessionId = session.sessionId
              resetSession.aiName = session.aiName
              setSession(resetSession)
              persistSessionSilently(resetSession)
            }}
          />
          <span
            className="gpt-util-icon"
            title={t('Open Independent Panel')}
            onClick={() => {
              Browser.runtime.sendMessage({
                type: 'NEW_URL',
                data: {
                  url: Browser.runtime.getURL('IndependentPanel.html') + '?from=store',
                },
              })
            }}
          >
            <ArchiveIcon size={16} />
          </span>
          {conversationItemData.length > 0 && (
            <span
              title={t('Jump to bottom')}
              className="gpt-util-icon"
              onClick={() => {
                bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
              }}
            >
              <MoveToBottomIcon size={16} />
            </span>
          )}
          <span
            title={t('Save Conversation')}
            className="gpt-util-icon"
            onClick={() => {
              let output = ''
              session.conversationRecords.forEach((data) => {
                output += `${t('Question')}:\n\n${data.question}\n\n${t('Answer')}:\n\n${
                  data.answer
                }\n\n<hr/>\n\n`
              })
              const blob = new Blob([output], { type: 'text/plain;charset=utf-8' })
              FileSaver.saveAs(blob, 'conversation.md')
            }}
          >
            <DesktopDownloadIcon size={16} />
          </span>
        </span>
      </div>
      <hr />
      <div
        ref={bodyRef}
        className="markdown-body"
        style={
          props.notClampSize
            ? { flexGrow: 1 }
            : { maxHeight: windowSize[1] * 0.55 + 'px', resize: 'vertical' }
        }
      >
        {renderConversationItems()}
      </div>
      {props.waitForTrigger && !triggered ? (
        <p
          className="manual-btn"
          style={{ display: 'flex', justifyContent: 'center' }}
          onClick={() => {
            setConversationItemData([
              new ConversationItemData(
                'answer',
                `<p class="gpt-loading">${t(`Waiting for response...`)}</p>`,
              ),
            ])
            setTriggered(true)
            setIsReady(false)
          }}
        >
          <span className="icon-and-text">
            <SearchIcon size="small" /> {t('Ask ChatGPT')}
          </span>
        </p>
      ) : (
        <InputBox
          enabled={isReady}
          postMessage={postMessage}
          reverseResizeDir={props.pageMode}
          onSubmit={async (question) => {
            latestQuestionRef.current = question
            const newQuestion = new ConversationItemData('question', question)
            const placeholders =
              selectedTargets && selectedTargets.length > 1
                ? selectedTargets.map(
                    (target) =>
                      new ConversationItemData(
                        'answer',
                        `<p class="gpt-loading">${t('Waiting for response...')}</p>`,
                        false,
                        { runId: 'pending', sourceTargetId: target.id },
                      ),
                  )
                : [
                    new ConversationItemData(
                      'answer',
                      `<p class="gpt-loading">${t('Waiting for response...')}</p>`,
                    ),
                  ]
            setConversationItemData([...conversationItemData, newQuestion, ...placeholders])
            setIsReady(false)

            const runId = selectedTargets && selectedTargets.length > 1 ? uuidv4() : null
            fanoutRunRef.current = runId
            const newSession = {
              ...session,
              question,
              isRetry: false,
              ...(runId ? { lastRunId: runId } : {}),
            }
            setSession((old) => ({
              ...newSession,
              conversationRecords:
                runId && selectedTargets && selectedTargets.length > 1
                  ? [...(old.conversationRecords || []), { question, answer: '', meta: { runId } }]
                  : old.conversationRecords,
            }))

            try {
              if (selectedTargets && selectedTargets.length > 1) {
                setFanoutStatuses(
                  Object.fromEntries(selectedTargets.map((target) => [target.id, 'running'])),
                )
                port.postMessage({
                  fanout: {
                    runId,
                    fanoutMode: session.fanout || config?.defaultFanout || 'parallel',
                    targets: selectedTargets.map((target) => ({
                      id: target.id,
                      apiMode: target.apiMode,
                      modelName: target.modelName,
                    })),
                  },
                  session: newSession,
                })
              } else {
                if (selectedTargets && selectedTargets.length === 1) {
                  const [target] = selectedTargets
                  newSession.apiMode = target.apiMode
                  newSession.modelName = target.modelName
                  newSession.aiName = modelNameToDesc(target.modelName, t, config.customModelName)
                  setSession({ ...newSession })
                }
                await postMessage({ session: newSession })
              }
            } catch (error) {
              updateAnswer(error, false, 'error')
            }

            bodyRef.current?.scrollTo({
              top: bodyRef.current.scrollHeight,
              behavior: 'instant',
            })
          }}
        />
      )}
    </div>
  )
}
ConversationCard.propTypes = {
  session: PropTypes.object.isRequired,
  question: PropTypes.string,
  onUpdate: PropTypes.func,
  draggable: PropTypes.bool,
  closeable: PropTypes.bool,
  onClose: PropTypes.func,
  dockable: PropTypes.bool,
  onDock: PropTypes.func,
  notClampSize: PropTypes.bool,
  pageMode: PropTypes.bool,
  waitForTrigger: PropTypes.bool,
}

export default memo(ConversationCard)
