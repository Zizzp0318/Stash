// M3 冒烟：未指定 folderId 时应自动导入到「未分类」文件夹
import { app } from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createLibrary, closeCurrent } from './library'
import { importFiles } from './importer'

export async function runSmokeM3(): Promise<void> {
  const result: Record<string, unknown> = {}
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke3-'))
    createLibrary({ name: 'smoke3-lib', parentDir: dir })
    const src = join(dir, 'src')
    mkdirSync(src)
    const p1 = join(src, 'a.txt')
    const p2 = join(src, 'b.jpg')
    writeFileSync(p1, 'x'.repeat(100))
    writeFileSync(p2, 'y'.repeat(200))
    const r = await new Promise<{ added: number; failed: unknown[] }>((resolve) => {
      importFiles({ paths: [p1, p2], mode: 'copy', onDone: (x) => resolve(x) })
    })
    result.import = { added: r.added, failedCount: r.failed.length, firstErr: r.failed[0] }
    const { db } = await import('./library').then((m) => m.requireCurrent())
    const folders = db.prepare('SELECT path FROM folders').all() as Array<{ path: string }>
    result.folders = folders.map((f) => f.path)
    const assets = db.prepare('SELECT folder_id FROM assets').all() as Array<{ folder_id: number }>
    result.assetFolderIds = assets.map((a) => a.folder_id)
    result.ok = r.added === 2 && r.failed.length === 0 && folders.some((f) => f.path === '未分类') && assets.every((a) => a.folder_id != null)
    console.log('[SMOKE-M3] ' + JSON.stringify(result))
  } catch (e) {
    result.ok = false
    result.error = String(e)
    console.log('[SMOKE-M3] ' + JSON.stringify(result))
  } finally {
    closeCurrent()
    if (dir) rmSync(dir, { recursive: true, force: true })
    app.exit(0)
  }
}
