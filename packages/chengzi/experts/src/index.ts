/** Cordis Host plugin for the Chengzi Pro experts: keeps the expert catalog
 *  materialized as agent presets and serves the merged catalog to the Client
 *  over a loopback route.
 *
 *  0.2 适配：preset 的唯一装载路径是 `agentPresets.register(PresetDefinition)`
 *  （不再有 `.agent-presets` 文件扫描）。本插件双轨保留既有产物语义：
 *  - 文件轨（不变）：`<DSH_HOME>/.agent-presets/expert-*` 三件套仍是同步
 *    diff（chengzi-expert.json）与「我的专家」存储的事实的源，agent.cordis.yml
 *    是组合的落盘留档；
 *  - registry 轨（新增）：每次同步/save/restore 后把专家经
 *    `preset-mounts` 注册进 `agentPresets`，Client 的
 *    `session.create({agentPreset})` 由此解析。effective standard 组合经
 *    registry 的 `readDocument('standard')` 获取（preset-standard 行激活有时
 *    序，readStandardComposition 带界轮询），不可读时降级 persona-only。
 *
 *  同步节律：启动即同步 + 每 30 分钟刷新 + catalog 路由被请求时若超过
 *  5 分钟未同步则先同步。远端失败降级内置清单（不删除任何已物化目录）。
 *
 *  云端技能包同步挂同一节律：把 BFF `/api/v1/skill-packages` 的包物化到
 *  `<DSH_HOME>/skills/<id>/`（skill-filesystem 默认用户根，一层扫描即可
 *  发现）。失败静默（warn 日志，绝不弹错）；下架包不删本地。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CHENGZI_BFF_BASE_URL } from 'dsh-plugin-chengzi-account'
import { fetchExpertCatalog } from './expert-client.js'
import type { CatalogResponse, ExpertDef } from './expert-types.js'
import { registerChengziExpertsRoutes, type ChengziExpertsRouteConfig } from './host-routes.js'
import { backupMineExpertsToCloud, restoreMineExpertsFromCloud } from './mine-cloud.js'
import { deleteMineExpertDirectory, listMineExperts, saveMineExpert } from './mine-experts.js'
import type { MineBackupResult, MineExpertInput, MineRestoreResult } from './mine-types.js'
import { createExpertPresetMounts } from './preset-mounts.js'
import {
  personaOnlyRows,
  readStandardComposition,
  type CompositionRow,
  type StandardComposition,
} from './preset-composition.js'
import { cloudSkillRoot, createSkillPackageSyncState } from './skill-sync.js'
import {
  fetchSkillPackageArchive,
  fetchSkillPackageCatalog,
  type SkillPackageCatalog,
} from './skill-packages-client.js'
import { createExpertCatalogState, expertsPresetRoot, resolveDshHome } from './sync.js'

/** Stable Cordis plugin name. */
export const name = 'chengzi-experts'

/** Host services required at activation: the loopback web server, its source
 *  check, the credential store（「我的专家」云端备份读登录会话用）, and the
 *  agent-preset registry（专家 preset 的 0.2 装载路径）. */
export const inject = ['webServer', 'connection', 'credentials', 'agentPresets']

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** 周期同步间隔：30 分钟。 */
const CATALOG_REFRESH_MS = 30 * 60_000

/** 目录超龄阈值：catalog 被请求时超过 5 分钟未同步则触发一次。 */
const CATALOG_MAX_AGE_MS = 5 * 60_000

/** Experts plugin policy. */
export interface Config {
  /** Account BFF origin; defaults to the account plugin's compiled-in production service. */
  bffBaseUrl: string
  /** Maximum duration of one catalog fetch before cancellation. */
  requestTimeoutMs: number
  /** Periodic resync interval. */
  syncIntervalMs: number
  /** Catalog staleness threshold served by the loopback route. */
  catalogMaxAgeMs: number
  /** Preset root override（默认 `<DSH_HOME>/.agent-presets`；测试/诊断用。空串=默认）。 */
  presetsRoot: string
  /** 云端技能包根目录 override（默认 `<DSH_HOME>/skills`；测试/诊断用。空串=默认）。 */
  skillRoot: string
  /** 单个技能包 zip 下载的最长时长（目录请求沿用 requestTimeoutMs）。 */
  packageDownloadTimeoutMs: number
}

/** Validated experts plugin policy. */
export const Config: z<Config> = z.object({
  bffBaseUrl: z.string().default(CHENGZI_BFF_BASE_URL),
  requestTimeoutMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(5_000),
  syncIntervalMs: z.number().step(1).min(60_000).max(MAX_TIMER_DELAY_MS).default(CATALOG_REFRESH_MS),
  catalogMaxAgeMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(CATALOG_MAX_AGE_MS),
  presetsRoot: z.string().default(''),
  skillRoot: z.string().default(''),
  packageDownloadTimeoutMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(60_000),
})

/**
 * Register the effect-scoped catalog route, start the sync cadence, and keep
 * the expert presets mounted in the agent-preset registry.
 * @param ctx - Host context carrying webServer, connection, credentials, and agentPresets.
 * @param config - validated plugin policy.
 */
export function apply(ctx: Context, config: Config): void {
  const root = config.presetsRoot.length > 0 ? config.presetsRoot : expertsPresetRoot(resolveDshHome())
  const warn = (message: string): void => {
    ctx.logger.warn(message)
  }

  // registry 挂载面：同步/自建/恢复三类产物都经它进出 agentPresets。
  const mounts = createExpertPresetMounts({
    register: definition => ctx.agentPresets.register(definition),
  })
  ctx.effect(
    () => () => { void mounts.disposeAll() },
    'chengzi-experts: preset registry mounts',
  )

  // effective standard 组合缓存：首读在启动时发起（带界轮询等待
  // preset-standard 行声明），同步执行期读取；读不到时按 persona-only 兜底。
  let standard: StandardComposition | undefined
  let standardLoaded = false
  const standardPromise = readStandardComposition({
    readDocument: agentPreset => ctx.agentPresets.readDocument(agentPreset),
  }, {
    onWait: (attempt, cause) => {
      if (attempt % 12 === 0) {
        warn(`dsh-plugin-chengzi-experts: waiting for the standard agent preset: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    },
  })
    .then((composition) => {
      standard = composition
      standardLoaded = true
      if (composition === undefined) {
        warn('dsh-plugin-chengzi-experts: the standard agent preset is unavailable; materializing persona-only expert presets')
      }
      return composition
    })
    .catch((cause: unknown) => {
      standardLoaded = true
      warn(`dsh-plugin-chengzi-experts: standard composition read failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      return undefined
    })

  /** 当前应供给专家 preset 的组合行：standard 可用用 standard，否则兜底。 */
  const compositionRowsFor = (): readonly CompositionRow[] =>
    standard?.rows ?? personaOnlyRows('')

  /** 把一位专家挂进 registry（失败仅 warn，不拖垮同批其余专家）。 */
  const mountExpert = (expert: ExpertDef): Promise<void> =>
    mounts.apply(expert, compositionRowsFor()).catch((cause: unknown) => {
      warn(`dsh-plugin-chengzi-experts: preset mount failed for "${expert.id}": ${cause instanceof Error ? cause.message : String(cause)}`)
    })

  const state = createExpertCatalogState({
    root,
    warn,
    standardText: (): string | undefined => standard?.text,
    fetchCatalog: async (): Promise<CatalogResponse> => await fetchExpertCatalog({
      baseUrl: config.bffBaseUrl,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    }),
  })

  // 云端技能包同步：与专家目录同步共用 Config 与调度点。skillState 内部
  // 吞错——syncNow / syncIfStale 永不 reject，失败静默，下一轮照常。
  const skillState = createSkillPackageSyncState({
    root: config.skillRoot.length > 0 ? config.skillRoot : cloudSkillRoot(resolveDshHome()),
    warn,
    fetchCatalog: async (): Promise<SkillPackageCatalog> => await fetchSkillPackageCatalog({
      baseUrl: config.bffBaseUrl,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    }),
    downloadPackage: async (id: string): Promise<Buffer> => await fetchSkillPackageArchive({
      baseUrl: config.bffBaseUrl,
      id,
      signal: AbortSignal.timeout(config.packageDownloadTimeoutMs),
    }),
  })

  // 启动同步：等待 standard 读取落定（成功或失败）后再跑，避免首屏走到 persona-only 兜底。
  const syncCatalog = (): void => {
    void standardPromise
      .then(async () => {
        const outcome = await state.syncNow()
        // registry 轨跟随文件同步：生效清单逐个挂载，领地外注销。
        for (const expert of outcome.experts) await mountExpert(expert)
        await mounts.retain(outcome.experts.map(expert => expert.id))
      })
      .catch((cause: unknown) => {
        warn(`dsh-plugin-chengzi-experts: expert sync failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
  }
  // 技能包无 standard 依赖，启动即同步（与目录启动同步同一时机、并行）。
  const syncSkills = (): void => {
    void skillState.syncNow()
  }
  syncSkills()
  void standardPromise.then(() => {
    syncCatalog()
  })
  const catalogTimer = setInterval((): void => {
    if (standardLoaded) syncCatalog()
    syncSkills()
  }, config.syncIntervalMs)
  ctx.effect(
    () => () => {
      clearInterval(catalogTimer)
    },
    'chengzi-experts: periodic catalog refresh',
  )

  const routeConfig: ChengziExpertsRouteConfig = {
    catalogMaxAgeMs: config.catalogMaxAgeMs,
    serveCatalog: async (maxAgeMs: number): Promise<CatalogResponse> => {
      if (!standardLoaded) await standardPromise
      // 超龄触发点与专家目录同步共用：catalog 路由被请求且技能包超过
      // 同一阈值未同步时补一次（后台进行，不阻塞路由响应）。
      void skillState.syncIfStale(config.catalogMaxAgeMs)
      return await state.serve(maxAgeMs)
    },
    listMine: async (): Promise<readonly ExpertDef[]> => await listMineExperts(root),
    saveMine: (input: MineExpertInput, id?: string): Promise<ExpertDef> => {
      // 等待 standard 读取落定后再落盘：避免首屏创建走到 persona-only 兜底。
      const save = async (): Promise<ExpertDef> => {
        const expert = await saveMineExpert(root, input, {
          ...(id === undefined ? {} : { id }),
          ...(standard?.text === undefined ? {} : { standardText: standard.text }),
          now: new Date(),
        })
        await mountExpert(expert)
        return expert
      }
      return standardLoaded ? save() : standardPromise.then(save)
    },
    deleteMine: (id: string): Promise<void> =>
      deleteMineExpertDirectory(root, id)
        .then(async () => { await mounts.forget(id) }),
    backupMine: async (): Promise<MineBackupResult> => await backupMineExpertsToCloud(
      await listMineExperts(root),
      {
        ctx,
        baseUrl: config.bffBaseUrl,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
        warn,
      },
    ),
    restoreMine: async (): Promise<MineRestoreResult> => {
      if (!standardLoaded) await standardPromise
      const result = await restoreMineExpertsFromCloud({
        ctx,
        baseUrl: config.bffBaseUrl,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
        root,
        ...(standard?.text === undefined ? {} : { standardText: standard.text }),
        warn,
      })
      // 恢复式覆盖：恢复完成后按本地现状重挂载「我的」命名空间。
      for (const expert of await listMineExperts(root)) await mountExpert(expert)
      return result
    },
  }
  ctx.effect(
    () => registerChengziExpertsRoutes(ctx, routeConfig),
    'chengzi-experts: local catalog route',
  )
}

export { CHENGZI_EXPERTS_ROUTE_CATALOG, CHENGZI_EXPERTS_ROUTE_MINE, CHENGZI_EXPERTS_ROUTE_MINE_BACKUP, CHENGZI_EXPERTS_ROUTE_MINE_RESTORE, registerChengziExpertsRoutes } from './host-routes.js'
export { BUILTIN_EXPERTS } from './builtin-experts.js'
export { ChengziExpertsError, fetchExpertCatalog, MAX_EXPERT_ROWS } from './expert-client.js'
export { listCustomExperts, MAX_CUSTOM_EXPERT_ROWS, MAX_CUSTOM_EXPERTS_RESPONSE_BYTES, putCustomExpert } from './custom-experts-client.js'
export {
  backupMineExpertsToCloud,
  isChengziBffError,
  isSessionRequiredError,
  restoreMineExpertsFromCloud,
  SessionRequiredError,
  withChengziSession,
} from './mine-cloud.js'
export {
  buildMineExpertDef,
  deleteMineExpertDirectory,
  deriveMineExpertId,
  listBrokenMineExperts,
  listMineExpertDirectories,
  listMineExperts,
  mergeCatalogWithMine,
  MineExpertValidationError,
  saveMineExpert,
  slugifyMineName,
  validateMineExpertInput,
} from './mine-experts.js'
export type { MineBackupResult, MineExpertInput, MineFailure, MineRestoreResult } from './mine-types.js'
export { MINE_ALLOWED_TOOLS, MINE_BADGE, MINE_LIMITS, partitionExperts } from './mine-types.js'
export { createExpertPresetMounts } from './preset-mounts.js'
export type { AgentPresetRegistrar, ExpertPresetMounts } from './preset-mounts.js'
export {
  expertPresetDefinition,
  parseCompositionRows,
  personaOnlyRows,
  readStandardComposition,
  withPersonaPrefix,
} from './preset-composition.js'
export type {
  AgentPresetReader, CompositionRow, PresetDocument, StandardComposition, StandardReadOptions,
} from './preset-composition.js'
export {
  ChengziSkillPackagesError,
  fetchSkillPackageArchive,
  fetchSkillPackageCatalog,
  MAX_SKILL_PACKAGE_ARCHIVE_BYTES,
  MAX_SKILL_PACKAGE_ROWS,
  MAX_SKILL_PACKAGES_RESPONSE_BYTES,
  SKILL_PACKAGE_ID_PATTERN,
} from './skill-packages-client.js'
export type { SkillPackageArchiveOptions, SkillPackageCatalog, SkillPackageSummary, SkillPackagesRequestOptions } from './skill-packages-client.js'
export {
  cloudSkillRoot,
  createSkillPackageSyncState,
  MAX_SKILL_PACKAGE_ENTRIES,
  MAX_SKILL_PACKAGE_UNCOMPRESSED_BYTES,
  parseFrontmatterName,
  SKILL_PACKAGE_STATE_FILE,
  SkillPackageValidationError,
  syncSkillPackages,
  validateSkillPackage,
} from './skill-sync.js'
export type { SkillPackageSyncState, SkillSyncDependencies, SkillSyncOutcome } from './skill-sync.js'
export {
  createExpertCatalogState,
  expertsPresetRoot,
  resolveDshHome,
  syncExpertPresets,
} from './sync.js'
export {
  COMPOSITION_FILE,
  EXPERT_METADATA_FILE,
  materializeExpertDirectory,
  MissingPersonaRowError,
  PRESET_METADATA_FILE,
  removeExpertDirectory,
  renderExpertMetadataFile,
  renderPresetMetadataFile,
  replacePersonaPrefix,
} from './materialize.js'
export type { CatalogResponse, ExpertDef } from './expert-types.js'
export type { ChengziExpertsRouteConfig } from './host-routes.js'
export type { ExpertCatalogState, SyncDependencies, SyncOutcome } from './sync.js'
export type { ExpertSource, MaterializedExpertMeta } from './materialize.js'
export type { CustomExpertsRequestOptions } from './custom-experts-client.js'
export type { MineCloudContext, MineCloudRestoreDeps, MineCloudSyncDeps } from './mine-cloud.js'
