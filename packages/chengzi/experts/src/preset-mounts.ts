/** 专家 preset 的 registry 挂载面：把同步/自建产物注册进
 *  `agentPresets`（0.2 唯一的 preset 装载路径），并在专家下架/删除时注销。
 *
 *  领地规则与文件物化一致：只挂载 `expert-*` 命名空间的 id（同步器与
 *  mine 存储已经把守，这里不再重复校验）。同一 id 重复 apply 先注销旧定义
 *  再注册新定义（registry 对重复 id 显式报错）；注册失败向上抛出，由
 *  调用方记 warn——挂载失败在 preset 选择器的 roster 里也会以 broken 呈现。
 * @module dsh-plugin-chengzi-experts/preset-mounts
 */

import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { CompositionRow } from './preset-composition.js'
import { expertPresetDefinition } from './preset-composition.js'
import type { ExpertDef } from './expert-types.js'

/** Registry slice this module needs；tests substitute a structural fake. */
export interface AgentPresetRegistrar {
  register(definition: PresetDefinition): Promise<() => Promise<void>>
}

/** 专家 preset 挂载状态机的依赖与产物。 */
export interface ExpertPresetMounts {
  /** 注册（或按 id 重注册）一位专家的 preset。 */
  apply(expert: ExpertDef, rows: readonly CompositionRow[]): Promise<void>
  /** 注销一位专家的 preset；未挂载时为 no-op。 */
  forget(expertId: string): Promise<void>
  /** 只保留 desiredIds 中的挂载（云端清单权威的删除判定走这里）。 */
  retain(desiredIds: readonly string[]): Promise<void>
  /** 当前挂载中的专家 id（诊断用）。 */
  mountedIds(): readonly string[]
  /** 插件停效时注销全部挂载。 */
  disposeAll(): Promise<void>
}

/**
 * 创建专家 preset 挂载状态机。
 * @param registrar - registry 的 register 切片。
 */
export function createExpertPresetMounts(registrar: AgentPresetRegistrar): ExpertPresetMounts {
  // id → registry 返回的注销器；「已挂载」的唯一事实源。
  const mounted = new Map<string, () => Promise<void>>()

  return {
    async apply(expert: ExpertDef, rows: readonly CompositionRow[]): Promise<void> {
      const previous = mounted.get(expert.id)
      if (previous !== undefined) {
        mounted.delete(expert.id)
        await previous()
      }
      const unregister = await registrar.register(expertPresetDefinition(expert, rows))
      mounted.set(expert.id, unregister)
    },
    async forget(expertId: string): Promise<void> {
      const unregister = mounted.get(expertId)
      if (unregister === undefined) return
      mounted.delete(expertId)
      await unregister()
    },
    async retain(desiredIds: readonly string[]): Promise<void> {
      const desired = new Set(desiredIds)
      for (const id of [...mounted.keys()]) {
        if (!desired.has(id)) await this.forget(id)
      }
    },
    mountedIds: (): readonly string[] => [...mounted.keys()],
    async disposeAll(): Promise<void> {
      const disposers = [...mounted.values()]
      mounted.clear()
      for (const dispose of disposers) await dispose()
    },
  }
}
