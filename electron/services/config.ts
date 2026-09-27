import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'

export interface Config {
  recentLibraries: string[]
}

let cache: Config | null = null

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

/**
 * 路径规范化：resolve 统一斜杠风格与相对段。
 * Windows 下同一个库可能以 "E:\a" / "E:/a" / "e:\A" 等多种写法出现，
 * 不规范化会导致最近列表出现重复项。
 */
function norm(p: string): string {
  try {
    return resolve(p)
  } catch {
    return p
  }
}

function normKey(p: string): string {
  return norm(p).toLowerCase()
}

/** 清洗 + 去重（保留顺序，先出现的在前） */
function dedupe(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const k = normKey(p)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(norm(p))
  }
  return out
}

function load(): Config {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(configPath(), 'utf-8'))
  } catch {
    cache = { recentLibraries: [] }
  }
  if (!Array.isArray(cache.recentLibraries)) cache.recentLibraries = []
  // 读取时顺带清洗历史脏数据（多写法重复项）
  const cleaned = dedupe(cache.recentLibraries)
  if (cleaned.length !== cache.recentLibraries.length || cleaned.some((p, i) => p !== cache.recentLibraries![i])) {
    cache.recentLibraries = cleaned
    save()
  }
  return cache
}

function save(): void {
  writeFileSync(configPath(), JSON.stringify(load(), null, 2), 'utf-8')
}

export function addRecentLibrary(p: string): void {
  const c = load()
  const np = norm(p)
  c.recentLibraries = [np, ...c.recentLibraries.map(norm).filter((x) => normKey(x) !== normKey(np))].slice(0, 10)
  save()
}

export function removeRecentLibrary(p: string): void {
  const c = load()
  const k = normKey(p)
  c.recentLibraries = c.recentLibraries.filter((x) => normKey(x) !== k)
  save()
}

export function listRecentLibraries(): string[] {
  const all = dedupe(load().recentLibraries)
  const alive = all.filter((p) => existsSync(join(p, '.stash')))
  // 目录已不存在的库（被外部删除/移动）自动从记录中剔除，保持配置自清理
  if (alive.length !== all.length) {
    const c = load()
    c.recentLibraries = alive
    save()
  }
  return alive
}
