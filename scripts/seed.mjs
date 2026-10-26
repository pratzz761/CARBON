import * as Y from 'yjs'
import { writeFileSync } from 'node:fs'

const notes = [
  {
    id: 'welcome', title: 'A place to think, together.',
    text: `Good notes are a conversation.

A half-finished thought. A question in the margin. The explanation that finally makes something click.

This is a small space for all of those things.

01 / MAKE IT YOURS

Start writing here, or open a fresh page. Give yourself a name in the sidebar, then share this notebook link with a classmate. You can both write at the same time.

02 / A LITTLE LESS NOISE

Every edit has somewhere to go. Sending each one immediately is quick, but many small messages can crowd a limited connection. Waiting too long makes the conversation feel slow.

The experiment finds a useful middle ground: the fastest synchronisation that fits a traffic budget.

03 / TRY IT FOR YOURSELF

Open “The experiment” to compare immediate sending, a fixed interval, and an interval chosen from 31 possibilities. The results come from real document updates in a controlled network replay.

On a good connection, the best answer might simply be: don’t wait.

— Your first page. Change anything.`,
  },
  {
    id: 'lecture-01', title: 'Lecture 01 — Making choices',
    text: `OPTIMISATION TECHNIQUES
Lecture 01 / Working notes

An optimisation problem starts with a choice.

What can we change?
What are we trying to improve?
What limits do we have to work within?

OUR RUNNING EXAMPLE

Three students are taking notes together. Their typing should appear immediately on their own screen. The question is when to send those changes to everyone else.

Decision variable
  T = time to collect updates before sending (ms)

Objective
  Minimise the 95th-percentile remote edit delay.

Constraints
  Stay within the collaboration traffic budget.
  Keep p95 delay at or below 500 ms.
  Preserve the final document on every replica.

METHOD

Try T = 0, 10, 20, …, 300 ms on the same traces.
Reject choices that break a constraint.
Select the fastest remaining choice.
Check it again on traces not used for selection.

QUESTIONS FOR NEXT TIME

• When does batching actually help?
• What changes when more classmates join?
• What should the app do if no choice is feasible?`,
  },
]

const seeds = notes.map(note => {
  const doc = new Y.Doc()
  doc.clientID = note.id === 'welcome' ? 100 : 101
  doc.getText('notes').insert(0, note.text)
  const update = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
  doc.destroy()
  return { id: note.id, title: note.title, update }
})
writeFileSync(new URL('../backend/seed.json', import.meta.url), JSON.stringify(seeds, null, 2) + '\n')
console.log('Generated two starter notes with real Yjs state.')
