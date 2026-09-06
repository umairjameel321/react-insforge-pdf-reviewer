/**
 * End-to-end backend check, run against the live InsForge project.
 *
 * Exercises the real user path with the anon key and an actual signed-in
 * session, so RLS is in force exactly as it is for the browser app:
 *   sign up -> upload to storage -> insert document + session -> ingest-pdf
 *   -> chat (RAG + memory) -> extract-memory -> cross-user isolation checks
 *
 * Usage: node scripts/e2e-check.mjs
 */
import { readFileSync } from 'node:fs'

import { createClient } from '@insforge/sdk'

const BASE_URL = process.env.VITE_INSFORGE_URL
const ANON_KEY = process.env.VITE_INSFORGE_ANON_KEY

if (!BASE_URL || !ANON_KEY) {
  console.error('Set VITE_INSFORGE_URL and VITE_INSFORGE_ANON_KEY (source .env first).')
  process.exit(1)
}

const stamp = Date.now()
const USER_A = { email: `e2e-a-${stamp}@example.com`, password: 'ReviewerTest123', name: 'Tester A' }
const USER_B = { email: `e2e-b-${stamp}@example.com`, password: 'ReviewerTest123', name: 'Tester B' }

const reason = (e) => (!e ? '' : typeof e === 'string' ? e : e.message || e.error || JSON.stringify(e))

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures++
}

function newClient() {
  return createClient({ baseUrl: BASE_URL, anonKey: ANON_KEY })
}

async function signUp(client, who) {
  const { data, error } = await client.auth.signUp(who)
  if (error) throw new Error(`signUp(${who.email}): ${error.message}`)
  if (!data?.accessToken) {
    throw new Error(`signUp(${who.email}) did not return a session (verification still required?)`)
  }
  return data.user.id
}

/* Chunk the test contract the same way the browser does, but page-per-chunk. */
function buildChunks() {
  return [
    {
      index: 0,
      pageFrom: 1,
      pageTo: 1,
      content:
        'Acme Corp Cloud Services Agreement. This agreement is between Acme Corp and the Customer. ' +
        'It is governed by the laws of Delaware. The initial term is 24 months from the effective date.',
    },
    {
      index: 1,
      pageFrom: 2,
      pageTo: 2,
      content:
        'Section 4: Payment Terms. Invoices are issued monthly and due within 30 days. Late payments ' +
        'accrue interest at 1.5 percent per month. The annual subscription fee is 48,000 US dollars.',
    },
    {
      index: 2,
      pageFrom: 3,
      pageTo: 3,
      content:
        'Section 7: Termination. Either party may terminate for convenience with 90 days written ' +
        'notice. Acme may terminate immediately if payment is more than 60 days overdue. On ' +
        'termination, Customer data is retained for 30 days then deleted.',
    },
    {
      index: 3,
      pageFrom: 4,
      pageTo: 4,
      content:
        'Section 11: Liability. Total liability is capped at the fees paid in the preceding 12 months. ' +
        'Neither party is liable for indirect or consequential damages. This cap does not apply to ' +
        'breaches of confidentiality.',
    },
  ]
}

async function main() {
  const pdfBytes = readFileSync('scripts/tmp/contract.pdf')

  /* ---------------------------------------------------------------- user A */
  const a = newClient()
  const userAId = await signUp(a, USER_A)
  check('user A signed up and has a session', Boolean(userAId))

  const documentId = crypto.randomUUID()
  const fileKey = `${userAId}/${documentId}.pdf`
  const file = new File([pdfBytes], 'contract.pdf', { type: 'application/pdf' })

  const upload = await a.storage.from('pdfs').upload(fileKey, file)
  check('upload to private pdfs bucket', !upload.error, upload.error?.message ?? '')

  const docInsert = await a.database
    .from('documents')
    .insert([
      {
        id: documentId,
        user_id: userAId,
        title: 'Acme Cloud Services Agreement',
        file_name: 'contract.pdf',
        file_key: fileKey,
        file_url: upload.data?.url ?? null,
        byte_size: pdfBytes.length,
        page_count: 4,
        char_count: 900,
        status: 'processing',
      },
    ])
    .select()
  check('insert document row', !docInsert.error, docInsert.error?.message ?? '')

  const sessionInsert = await a.database
    .from('chat_sessions')
    .insert([{ user_id: userAId, document_id: documentId, title: 'Acme Cloud Services Agreement' }])
    .select()
  check('insert chat session', !sessionInsert.error, sessionInsert.error?.message ?? '')

  const sessionId = (Array.isArray(sessionInsert.data) ? sessionInsert.data[0] : sessionInsert.data)?.id
  check('session id returned', Boolean(sessionId))

  /* -------------------------------------------------- size cap enforcement */
  const oversize = await a.database.from('documents').insert([
    {
      user_id: userAId,
      title: 'Too big',
      file_name: 'big.pdf',
      file_key: `${userAId}/big.pdf`,
      byte_size: 11 * 1024 * 1024,
      page_count: 5,
    },
  ])
  check('10 MiB byte_size CHECK rejects an oversize document', Boolean(oversize.error))

  const overPages = await a.database.from('documents').insert([
    {
      user_id: userAId,
      title: 'Too long',
      file_name: 'long.pdf',
      file_key: `${userAId}/long.pdf`,
      byte_size: 1000,
      page_count: 500,
    },
  ])
  check('120-page CHECK rejects an over-long document', Boolean(overPages.error))

  /* ------------------------------------------------------------- ingestion */
  console.log('\n... running ingest-pdf (embeddings + opening review)')
  const ingest = await a.functions.invoke('ingest-pdf', {
    body: { documentId, sessionId, chunks: buildChunks() },
  })
  check(
    'ingest-pdf succeeded',
    !ingest.error && !ingest.data?.error,
    ingest.data?.error ?? reason(ingest.error),
  )
  check('all 4 chunks embedded', ingest.data?.chunkCount === 4, `got ${ingest.data?.chunkCount}`)
  check('opening review generated', Boolean(ingest.data?.summary))
  if (ingest.data?.summary) {
    console.log(`\n--- opening review (${ingest.data.model}) ---\n${ingest.data.summary}\n`)
  }

  const readyDoc = await a.database
    .from('documents')
    .select('status, chunk_count')
    .eq('id', documentId)
    .maybeSingle()
  check('document marked ready', readyDoc.data?.status === 'ready', readyDoc.data?.status ?? '')

  /* ------------------------------------------------------------------ chat */
  console.log('... asking a question that needs page 3')
  const turn1 = await a.functions.invoke('chat', {
    body: {
      sessionId,
      message:
        'I am a procurement lead reviewing this for renewal. How much notice do we need to give to terminate?',
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
    },
  })
  check('chat returned an answer', Boolean(turn1.data?.answer), turn1.data?.error ?? reason(turn1.error))
  const answer1 = turn1.data?.answer ?? ''
  check('answer found the 90-day notice period', /90/.test(answer1), answer1.slice(0, 120))
  check('answer carries page citations', (turn1.data?.citations?.length ?? 0) > 0)
  if (answer1) console.log(`\n--- answer 1 (${turn1.data.model}) ---\n${answer1}\n`)

  console.log('... running extract-memory')
  const mem = await a.functions.invoke('extract-memory', { body: { sessionId } })
  check('extract-memory ran', mem.data?.ok !== false, mem.data?.error ?? reason(mem.error))
  const created = mem.data?.created ?? []
  console.log(`    extracted ${created.length}: ${created.map((m) => `[${m.kind}] ${m.content}`).join(' | ')}`)

  const memories = await a.database.from('user_memories').select('id, kind, content').limit(20)
  check('memories persisted to the vector table', (memories.data?.length ?? 0) > 0)

  /* ---------------------------------------- second turn should use history */
  console.log('... asking a follow-up that only makes sense with short-term memory')
  const turn2 = await a.functions.invoke('chat', {
    body: { sessionId, message: 'And what about the fee — is it monthly or annual?', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
  })
  const answer2 = turn2.data?.answer ?? ''
  check('follow-up answered', Boolean(answer2), turn2.data?.error ?? reason(turn2.error))
  check('follow-up found the 48,000 annual fee', /48[,.]?000|annual/i.test(answer2), answer2.slice(0, 120))
  if (answer2) console.log(`\n--- answer 2 ---\n${answer2}\n`)

  const stored = await a.database.from('messages').select('role, content').eq('session_id', sessionId)
  check('conversation history persisted', (stored.data?.length ?? 0) >= 4, `${stored.data?.length} messages`)

  const sessionRow = await a.database
    .from('chat_sessions')
    .select('message_count, last_message_at')
    .eq('id', sessionId)
    .maybeSingle()
  check(
    'session counters maintained by trigger',
    (sessionRow.data?.message_count ?? 0) >= 4 && Boolean(sessionRow.data?.last_message_at),
    `count=${sessionRow.data?.message_count}`,
  )

  /* ----------------------------------------------- append-only enforcement */
  const tamper = await a.database
    .from('messages')
    .update({ content: 'rewritten' })
    .eq('session_id', sessionId)
  check('messages are append-only (UPDATE denied)', Boolean(tamper.error), tamper.error?.message ?? 'update succeeded!')

  /* ------------------------------------------------ cross-user RLS checks */
  console.log('\n... checking isolation as a second user')
  const b = newClient()
  const userBId = await signUp(b, USER_B)
  check('user B signed up', Boolean(userBId))

  const bDocs = await b.database.from('documents').select('id').limit(50)
  check("user B cannot read user A's documents", (bDocs.data?.length ?? 0) === 0, `saw ${bDocs.data?.length}`)

  const bSessions = await b.database.from('chat_sessions').select('id').limit(50)
  check("user B cannot read user A's sessions", (bSessions.data?.length ?? 0) === 0)

  const bMessages = await b.database.from('messages').select('id').limit(50)
  check("user B cannot read user A's messages", (bMessages.data?.length ?? 0) === 0)

  const bChunks = await b.database.from('doc_chunks').select('id').limit(50)
  check("user B cannot read user A's PDF chunks", (bChunks.data?.length ?? 0) === 0)

  const bMemories = await b.database.from('user_memories').select('id').limit(50)
  check("user B cannot read user A's memories", (bMemories.data?.length ?? 0) === 0)

  const bDownload = await b.storage.from('pdfs').download(fileKey)
  check("user B cannot download user A's PDF", Boolean(bDownload.error), bDownload.error ? '' : 'download succeeded!')

  const bChat = await b.functions.invoke('chat', {
    body: { sessionId, message: 'What is the termination notice?' },
  })
  check(
    "user B cannot chat into user A's session",
    Boolean(bChat.data?.error) || bChat.data?.answer === undefined,
    bChat.data?.answer ? 'got an answer!' : (bChat.data?.error ?? ''),
  )

  // Vector search must not leak across users even though the RPC is shared.
  const bVector = await b.database.rpc('match_doc_chunks', {
    query_embedding: Array(1024).fill(0.01),
    p_document_id: documentId,
    match_count: 5,
    match_threshold: 0,
  })
  check('match_doc_chunks respects RLS for a foreign document', (bVector.data?.length ?? 0) === 0)

  const bForge = await b.database.from('messages').insert([
    { user_id: userBId, session_id: sessionId, role: 'user', content: 'injected' },
  ])
  check("user B cannot write into user A's session", Boolean(bForge.error))

  const bSpoof = await b.database.from('documents').insert([
    {
      user_id: userAId,
      title: 'Spoofed',
      file_name: 'x.pdf',
      file_key: `${userAId}/x.pdf`,
      byte_size: 100,
      page_count: 1,
    },
  ])
  check('user B cannot create a row owned by user A', Boolean(bSpoof.error))

  /* --------------------------------------------------------------- cleanup */
  console.log('\n... cleaning up test data')
  await a.database.from('documents').delete().eq('id', documentId)
  await a.storage.from('pdfs').remove(fileKey)
  for (const memory of memories.data ?? []) {
    await a.database.from('user_memories').delete().eq('id', memory.id)
  }

  const leftover = await a.database.from('messages').select('id').eq('session_id', sessionId)
  check('deleting the document cascaded its messages', (leftover.data?.length ?? 0) === 0)

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nE2E run threw:', err.message)
  process.exit(1)
})
