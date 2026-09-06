import { Fragment, type ReactNode } from 'react'

/**
 * Minimal renderer for the light markdown free models emit: **bold**, *italic*,
 * `code`, and "- " bullet lists.
 *
 * Everything is built as React nodes rather than HTML strings, so model output
 * is never interpreted as markup and there is no injection surface.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).map((part, index) => {
    const key = `${keyPrefix}-${index}`

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} className="rounded bg-stone-100 px-1 py-0.5 text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return (
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>
      )
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

type Block = { type: 'list'; items: string[] } | { type: 'text'; lines: string[] }

function toBlocks(content: string): Block[] {
  const blocks: Block[] = []

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd()
    const bullet = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/)
    const last = blocks[blocks.length - 1]

    if (bullet) {
      if (last?.type === 'list') last.items.push(bullet[1])
      else blocks.push({ type: 'list', items: [bullet[1]] })
      continue
    }

    // Drop headings markers but keep the text, since we render no headings.
    const text = line.replace(/^#{1,6}\s+/, '')

    if (last?.type === 'text') last.lines.push(text)
    else blocks.push({ type: 'text', lines: [text] })
  }

  return blocks
}

export function RichText({ content }: { content: string }) {
  const blocks = toBlocks(content)

  return (
    <div className="space-y-2 leading-relaxed">
      {blocks.map((block, blockIndex) => {
        if (block.type === 'list') {
          return (
            <ul key={blockIndex} className="ml-1 list-disc space-y-1 pl-4">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item, `${blockIndex}-${itemIndex}`)}</li>
              ))}
            </ul>
          )
        }

        // Collapse the blank lines that separated blocks into paragraphs.
        const paragraphs = block.lines
          .join('\n')
          .split(/\n{2,}/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean)

        return (
          <Fragment key={blockIndex}>
            {paragraphs.map((paragraph, paragraphIndex) => (
              <p key={paragraphIndex} className="whitespace-pre-wrap break-words">
                {renderInline(paragraph, `${blockIndex}-${paragraphIndex}`)}
              </p>
            ))}
          </Fragment>
        )
      })}
    </div>
  )
}
