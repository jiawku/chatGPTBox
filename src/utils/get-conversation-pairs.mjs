export function getConversationPairs(records, isCompletion) {
  let pairs
  if (isCompletion) {
    pairs = ''
    for (const record of records) {
      pairs += 'Human: ' + record.question + '\nAI: ' + record.answer + '\n'
    }
  } else {
    pairs = []
    for (const record of records) {
      const question = record?.question
      if (typeof question === 'string') pairs.push({ role: 'user', content: question })
      const answer = record?.answer
      if (typeof answer === 'string') pairs.push({ role: 'assistant', content: answer })
    }
  }

  return pairs
}
