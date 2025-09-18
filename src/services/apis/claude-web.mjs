import { pushRecord, setAbortController } from './shared.mjs'
import { getUserConfig } from '../../config/index.mjs'
import Claude from '../clients/claude'
import { getModelValue } from '../../utils/model-name-convert.mjs'

/**
 * @param {Runtime.Port} port
 * @param {string} question
 * @param {Session} session
 * @param {string} sessionKey
 */
export async function generateAnswersWithClaudeWebApi(port, question, session, sessionKey) {
  const bot = new Claude({ sessionKey })
  await bot.init()
  const { controller, cleanController } = setAbortController(port)
  const model = getModelValue(session)
  const config = await getUserConfig()

  async function withSearchContext(q) {
    if (!config.claudeWebSearchEnabled) return q
    try {
      const n = Math.max(1, Math.min(5, config.claudeWebSearchNumResults || 3))
      const url = 'https://www.bing.com/search?' + new URLSearchParams({ q, count: n.toString() })
      const resp = await fetch(url, {
        headers: {
          'Accept-Language': (typeof navigator !== 'undefined' && navigator.language) || 'en-US',
        },
      })
      const html = await resp.text()
      // naive extraction of result blocks
      const blocks = []
      const regex =
        /<li class="b_algo"[\s\S]*?<h2>([\s\S]*?)<\/h2>[\s\S]*?<p>([\s\S]*?)<\/p>[\s\S]*?<a href="([^"]+)"/g
      let m
      while ((m = regex.exec(html)) && blocks.length < n) {
        const title = m[1].replace(/<[^>]+>/g, '').trim()
        const snippet = m[2].replace(/<[^>]+>/g, '').trim()
        const link = m[3]
        if (title && snippet) blocks.push({ title, snippet, link })
      }
      if (!blocks.length) return q
      const preamble =
        'SYSTEM: You have access to brief web search context gathered beforehand. Use it to improve factual accuracy. ' +
        'Do not cite speculation as fact.\n\n' +
        blocks.map((b, i) => `${i + 1}. ${b.title}\n${b.snippet}\n${b.link}`).join('\n\n') +
        '\n\nUSER:\n' +
        q
      return preamble
    } catch (e) {
      return q
    }
  }

  let answer = ''
  const progressFunc = ({ completion }) => {
    answer = completion
    port.postMessage({ answer: answer, done: false, session: null })
  }

  const doneFunc = () => {
    pushRecord(session, question, answer)
    console.debug('conversation history', { content: session.conversationRecords })
    port.postMessage({ answer: answer, done: true, session: session })
  }

  const params = {
    progress: progressFunc,
    done: doneFunc,
    model,
    signal: controller.signal,
  }

  const finalQuestion = await withSearchContext(question)
  if (!session.claude_conversation)
    await bot
      .startConversation(finalQuestion, params)
      .then((conversation) => {
        conversation.request = null
        conversation.claude = null
        session.claude_conversation = conversation
        port.postMessage({ answer: answer, done: true, session: session })
        cleanController()
      })
      .catch((err) => {
        cleanController()
        throw err
      })
  else
    await bot
      .sendMessage(finalQuestion, {
        conversation: session.claude_conversation,
        ...params,
      })
      .then(cleanController)
      .catch((err) => {
        cleanController()
        throw err
      })
}
