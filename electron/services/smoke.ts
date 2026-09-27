// M1 冒烟测试：electron . --smoke-m1
// 验收：建库 → 导入 1 万文件（计时）→ 全库查重二次导入全跳过 → SQL 可查
import { app } from 'electron'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createLibrary, mkdirRel, closeCurrent, openLibrary } from './library'
import { importFiles } from './importer'
import { listAssets } from './assets'

const N = 10000

export async function runSmoke(): Promise<void> {
  const result: Record<string, unknown> = {}
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'stash-smoke-'))

    // 1. 建库
    const lib = createLibrary({ name: 'smoke-lib', parentDir: dir })
    result.library = lib

    // 2. 目标文件夹（真实目录 + 索引）
    const folder = mkdirRel('照片/批次A')
    result.folder = folder.path

    // 3. 生成 1 万个测试文件
    const srcDir = join(dir, 'src')
    mkdirSync(srcDir)
    const paths: string[] = []
    for (let i = 0; i < N; i++) {
      const p = join(srcDir, `file_${String(i).padStart(5, '0')}.txt`)
      writeFileSync(p, `stash smoke test payload ${i} ${'x'.repeat(200)}`)
      paths.push(p)
    }
    result.generated = paths.length

    // 4. 导入（复制模式）+ 计时
    const t0 = Date.now()
    const first = await new Promise<{ added: number; skipped: number }>((resolve) => {
      importFiles({
        paths, folderId: folder.id, mode: 'copy',
        onDone: (r) => resolve(r)
      })
    })
    result.importMs = Date.now() - t0
    result.firstImport = first

    // 5. SQL 可查
    const list = listAssets({ folderId: folder.id, limit: 5 })
    result.queryTotal = list.total

    // 6. 查重：重复导入应全跳过
    const t1 = Date.now()
    const second = await new Promise<{ added: number; skipped: number }>((resolve) => {
      importFiles({
        paths, folderId: folder.id, mode: 'copy',
        onDone: (r) => resolve(r)
      })
    })
    result.dedupMs = Date.now() - t1
    result.secondImport = second

    // 7. 重新打开库（可迁移验证的前半段）
    closeCurrent()
    openLibrary(lib.path)
    result.reopenTotal = listAssets({ type: 'text', limit: 1 }).total

    result.ok =
      first.added === N &&
      list.total === N &&
      second.skipped === N &&
      second.added === 0 &&
      result.reopenTotal === N

    console.log('[SMOKE-M1] ' + JSON.stringify(result, null, 2))
  } catch (e) {
    result.ok = false
    result.error = String(e)
    console.log('[SMOKE-M1] ' + JSON.stringify(result, null, 2))
  } finally {
    closeCurrent()
    if (dir) rmSync(dir, { recursive: true, force: true })
    app.exit(0)
  }
}
