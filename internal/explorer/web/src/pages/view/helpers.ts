import type { ViewResult } from '../../api'

export function isCOB(fmt: string): boolean {
  return fmt.includes('cob')
}

export function isGAF(fmt: string): boolean {
  return fmt.includes('gaf')
}

export function isPCX(fmt: string): boolean {
  return fmt.includes('pcx')
}

export function isVideo(fmt: string): boolean {
  return fmt.includes('smacker') || fmt.includes('video') || fmt.includes('zrb')
}

export function isAI(fmt: string): boolean {
  return fmt.includes('ai profile') || fmt.includes('ai behavior')
}

export function isBOS(fmt: string): boolean {
  return fmt.includes('bos') || fmt.includes('header')
}

export function isWAV(fmt: string): boolean {
  return fmt.includes('wav audio')
}

export function isAudio(fmt: string): boolean {
  return fmt.includes('wav audio') || fmt.includes('mp3 audio')
}

export function isPalette(fmt: string): boolean {
  return fmt === 'palette'
}

export function isTNT(fmt: string): boolean {
  return fmt.includes('tnt map')
}

export function isSCT(fmt: string): boolean {
  return fmt.includes('sct section')
}

export function is3DO(fmt: string): boolean {
  return fmt.includes('3do model')
}

export function isFont(fmt: string): boolean {
  return fmt.includes('ta font')
}

export function isColorTable(fmt: string): boolean {
  return fmt.includes('blending table') || fmt.includes('lighting table') || fmt.includes('shadow table')
}

// isImage matches the native browser-renderable image formats the server
// surfaces an imageUrl for (PNG/JPG/GIF/BMP/WebP/SVG). PCX uses its own
// dedicated viewer because it carries a palette and needs server-side
// conversion to a browser-readable format.
export function isImage(fmt: string): boolean {
  const lower = fmt.toLowerCase()
  return lower.includes('image') && !lower.includes('pcx')
}

export function isHTML(fmt: string): boolean {
  return fmt.toLowerCase() === 'html'
}

export function hasSections(data: ViewResult): boolean {
  return Array.isArray(data.sections) && data.sections.length > 0
}

export function buildTabs(data: ViewResult) {
  const fmt = (data.format || '').toLowerCase()

  // BOS/Header files get a tailored tab set.
  if (isBOS(fmt) && data.isText && data.textContent) {
    const tabs = [
      { id: 'content', label: '💻 Code' },
      { id: 'text', label: '📄 Text' },
    ]
    if ((data as Record<string, unknown>).callGraphNodes) {
      tabs.push({ id: 'callgraph', label: '🔗 Calls & Signals' })
    }
    const bosLint = (data as Record<string, unknown>).lintResults as unknown[] | undefined
    const bosLintErr = (data as Record<string, unknown>).lintError as string | undefined
    if (bosLint || bosLintErr) {
      const n = bosLint ? bosLint.length : 0
      tabs.push({ id: 'lint', label: `🔍 Lint${n > 0 ? ` (${n})` : ''}` })
    }
    tabs.push({ id: 'metadata', label: '📋 Metadata' })
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // TNT map files get a tailored tab set.
  if (isTNT(fmt)) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '🗺️ Map' },
      { id: 'features', label: '🏗️ Features' },
      { id: 'tiles', label: '🧩 Tiles' },
      { id: 'heightmap', label: '⛰️ Height Map' },
    ]
    const tntLint = (data as Record<string, unknown>).lintResults as unknown[] | undefined
    const tntLintErr = (data as Record<string, unknown>).lintError as string | undefined
    if (tntLint || tntLintErr) {
      const n = tntLint ? tntLint.length : 0
      tabs.push({ id: 'lint', label: `🔍 Lint${n > 0 ? ` (${n})` : ''}` })
    }
    tabs.push({ id: 'metadata', label: '📋 Metadata' })
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // SCT section files get a tailored tab set.
  if (isSCT(fmt)) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '🗺️ Section' },
      { id: 'tiles', label: '🧩 Tiles' },
      { id: 'heightmap', label: '⛰️ Height Map' },
      { id: 'metadata', label: '📋 Metadata' },
    ]
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // 3DO model files get a tailored tab set.
  if (is3DO(fmt)) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '🎮 Model' },
      { id: 'metadata', label: '📋 Metadata' },
    ]
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // Font files get a tailored tab set.
  if (isFont(fmt)) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '🔤 Font' },
      { id: 'metadata', label: '📋 Metadata' },
    ]
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // Palette and color table files get a tailored tab set.
  if (isPalette(fmt) || isColorTable(fmt)) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '🎨 Palette' },
      { id: 'metadata', label: '📋 Metadata' },
    ]
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // Audio files (WAV, MP3) get a tailored tab set.
  if (isAudio(fmt)) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '🔊 Player' },
      { id: 'metadata', label: '📋 Metadata' },
    ]
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // Inline image files (PNG/JPG/GIF/...) get a minimal viewer tab set.
  if (isImage(fmt)) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '🖼 Image' },
    ]
    tabs.push({ id: 'metadata', label: '📋 Metadata' })
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // HTML files get an iframe viewer.
  if (isHTML(fmt)) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '🌐 Page' },
    ]
    if (data.isText && data.textContent) {
      tabs.push({ id: 'text', label: '📄 Source' })
    }
    tabs.push({ id: 'metadata', label: '📋 Metadata' })
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // Video/ZRB/SMK files get a tailored tab set.
  if (isVideo(fmt)) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '🎬 Viewer' },
      { id: 'metadata', label: '📋 Metadata' },
    ]
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // TDF/FBI/GUI files get a tailored tab set.
  if (hasSections(data)) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '📑 Sections' },
    ]
    if (data.isText && data.textContent) {
      tabs.push({ id: 'text', label: '📄 Text' })
    }
    tabs.push({ id: 'metadata', label: '📋 Metadata' })
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // GAF files get a tailored tab set.
  if (isGAF(fmt)) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '🎞 Sequences' },
      { id: 'metadata', label: '📋 Metadata' },
    ]
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // AI profile files get a tailored tab set.
  if (isAI(fmt) && data.aiPlans) {
    const tabs: { id: string; label: string }[] = [
      { id: 'content', label: '🤖 AI Profile' },
    ]
    if (data.isText && data.textContent) {
      tabs.push({ id: 'text', label: '📄 Text' })
    }
    tabs.push({ id: 'metadata', label: '📋 Metadata' })
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // COB files get a tailored tab set.
  if (isCOB(fmt)) {
    const tabs: { id: string; label: string }[] = []
    if (data.decompiled) {
      tabs.push({ id: 'decompiled', label: '📝 Decompiled' })
    }
    if (data.disassembly) {
      tabs.push({ id: 'disassembly', label: '🔧 Disassembly' })
    }
    if ((data as Record<string, unknown>).callGraphNodes) {
      tabs.push({ id: 'callgraph', label: '🔗 Calls & Signals' })
    }
    const cobLint = (data as Record<string, unknown>).lintResults as unknown[] | undefined
    const cobLintCount = cobLint ? cobLint.length : 0
    tabs.push({ id: 'lint', label: `🔍 Lint${cobLintCount > 0 ? ` (${cobLintCount})` : ''}` })
    tabs.push({ id: 'metadata', label: '📋 Metadata' })
    if (data.hexDump) {
      tabs.push({ id: 'binary', label: '🔢 Binary' })
    }
    if (data.layers && data.layers.length > 0) {
      tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
    }
    return tabs
  }

  // Default tab set for all other formats.
  const tabs = [{ id: 'content', label: '👁 Content' }]

  if (data.isText && data.textContent) {
    tabs.push({ id: 'text', label: '📄 Source' })
  }

  tabs.push({ id: 'info', label: '📋 Info' })
  tabs.push({ id: 'describe', label: '🔍 Describe' })

  if (data.hexDump) {
    tabs.push({ id: 'binary', label: '🔢 Binary' })
  }
  if (data.layers && data.layers.length > 0) {
    tabs.push({ id: 'layers', label: `📚 Layering (${data.layers.length})` })
  }

  return tabs
}
