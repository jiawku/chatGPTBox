/**
 * Build a merged assistant message from multiple replies.
 * @param {{strategy: 'concatenate'|'summarize'|'compare', replies: Array<{label?: string, text: string}>, meta?: object}} params
 * @returns {{ text: string, meta: object }}
 */
export function buildMergedMessage({ strategy = 'concatenate', replies = [], meta = {} } = {}) {
  if (strategy === 'concatenate') {
    const text = replies
      .map((r, i) => `[#${i + 1}${r.label ? ` ${r.label}` : ''}]\n${r.text}`)
      .join('\n\n---\n\n')
    return { text, meta: { ...meta, strategy } }
  }
  // For summarize/compare, leave placeholder to be handled by a target model prompt in UI/background
  const text = replies
    .map((r, i) => `[#${i + 1}${r.label ? ` ${r.label}` : ''}]\n${r.text}`)
    .join('\n\n')
  return { text, meta: { ...meta, strategy } }
}
