/** Model-facing `aoci` tool: runs a whitelisted aoci-code CLI subcommand in
 *  the session workspace so the per-repository cognition index is one call
 *  away for every agent session. */

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { platform } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Subcommands the tool forwards; governance/read workflows plus the index
 *  lifecycle. `mcp` is excluded on purpose (the CLI MCP server binds to one
 *  repository per process and is not a per-call subcommand). */
const SUBCOMMANDS = [
  'status', 'capabilities', 'doctor', 'scan', 'init', 'verify', 'check',
  'index', 'scope', 'baseline', 'cognition', 'database', 'source', 'config',
  'ui', 'update-entry', 'remove-entry',
] as const

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_ARGS = 16
const MAX_ARG_LENGTH = 500
const OUTPUT_LIMIT_BYTES = 32 * 1024

export interface AociToolResult {
  readonly status: 'ok' | 'not-installed' | 'error'
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
  readonly installGuide?: string
}

const INSTALL_GUIDE = [
  'aoci 尚未安装。请客户或经客户同意后安装（本地单文件，约 24MB）：',
  '1. 从 https://github.com/aoci-spec/aoci-code/releases 下载最新 windows_amd64.zip（macOS 用 darwin 包）；',
  '2. 解压得到 aoci.exe，放到固定目录（例如 C:\\Tools\\aoci\\）；',
  '3. 把该目录加入系统 PATH，或设置环境变量 AOCI_PATH 指向 aoci.exe 完整路径；',
  '4. 在新会话中重试 `aoci status` 验证。',
  '安装说明也可让客户参考项目 README（github.com/aoci-spec/aoci-code）。',
].join('\n')

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Resolve the aoci binary: AOCI_PATH wins, then a PATH scan for the platform
 *  file name. Returns undefined when the CLI is not installed. */
export function resolveAociBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.AOCI_PATH
  if (typeof override === 'string' && override.length > 0 && isExecutableFile(override)) return override
  const fileName = platform() === 'win32' ? 'aoci.exe' : 'aoci'
  const searchPath = env.PATH
  if (typeof searchPath !== 'string' || searchPath.length === 0) return undefined
  for (const dir of searchPath.split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = isAbsolute(dir) ? join(dir, fileName) : join(process.cwd(), dir, fileName)
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}

/** True for aoci's only repository-override flag, `--repo` ("explicit
 *  repository root, overrides automatic discovery"). Forwarding it would let a
 *  session read or write another project's cognition index, so the tool strips
 *  both spellings — the bare flag together with its following value, so the
 *  path cannot survive as a positional argument. */
export function isRepoOverrideArg(arg: string): boolean {
  return arg === '--repo' || arg.startsWith('--repo=')
}

/** Whitelist-shape the forwarded args: strings only, length-capped, capped
 *  count, and with every `--repo` redirect removed. The session workspace is
 *  the only repository this tool will ever touch. */
export function sanitizeForwardedArgs(rawArgs: readonly unknown[]): string[] {
  const forwarded: string[] = []
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > MAX_ARG_LENGTH) continue
    if (isRepoOverrideArg(arg)) {
      if (arg === '--repo') index += 1
      continue
    }
    forwarded.push(arg)
    if (forwarded.length >= MAX_ARGS) break
  }
  return forwarded
}

function truncate(value: string): string {
  return value.length > OUTPUT_LIMIT_BYTES
    ? `${value.slice(0, OUTPUT_LIMIT_BYTES)}\n…（输出超过 32KB 已截断）`
    : value
}

interface AociRun {
  readonly error: { readonly code?: string | number } & Error | null
  readonly stdout: string
  readonly stderr: string
}

function execAoci(binary: string, args: readonly string[], cwd: string, timeout: number): Promise<AociRun> {
  return new Promise((resolve) => {
    execFile(binary, [...args], {
      cwd,
      timeout,
      maxBuffer: 4 * OUTPUT_LIMIT_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout: string, stderr: string) => {
      resolve({
        error: (error as { code?: string | number } & Error | null) ?? null,
        stdout,
        stderr,
      })
    })
  })
}

export function defineAociTool() {
  return defineTool({
    name: 'aoci',
    description: [
      '在当前会话工作区运行 aoci-code CLI（仓库认知索引）：读写 Git 版本化的整仓库认知层（aoci.txt），',
      '让会话带着对整个代码库的结构化理解开工。常用调用：`aoci status`（索引是否存在/是否对齐）、',
      '`aoci capabilities`（本机能力清单）、`aoci index agent guide --json`（索引构建实时引导）、',
      '`aoci scan`、`aoci verify`、`aoci index search <词>`。首次接触项目先跑 status；项目使用规则见',
      '其 AGENTS.md 的 aoci 托管块。命令在会话工作区内执行，索引只写本仓库。',
    ].join(''),
    parameters: {
      subcommand: {
        type: 'string',
        required: true,
        enum: [...SUBCOMMANDS],
        description: 'aoci 子命令（白名单）。',
      },
      args: {
        type: 'array',
        description: '透传给子命令的参数（如 ["agent","guide","--json"] 配合 subcommand=index）。仓库重定向旗标 --repo 会被剥离：索引始终锁定当前会话工作区所属仓库，不读写其他项目。',
        items: { type: 'string' },
      },
      timeoutMs: {
        type: 'number',
        description: `可选超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}；scan/大仓库操作建议放宽）。`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok', 'not-installed', 'error'], required: true },
          exitCode: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          installGuide: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.status}\n${value.stdout ?? value.stderr ?? value.installGuide ?? ''}`.slice(0, 4000) }],
    },
    async execute(args, exec): Promise<AociToolResult> {
      const binary = resolveAociBinary()
      if (binary === undefined) {
        return { status: 'not-installed', installGuide: INSTALL_GUIDE } satisfies AociToolResult
      }
      const sessionCwd = exec.agent === undefined ? undefined : exec.agent.session.header.cwd
      if (typeof sessionCwd !== 'string' || sessionCwd.length === 0) {
        throw new Error('aoci 需要一个会话工作区（session workspace）；请在打开项目的工作区会话中调用。')
      }
      const cwd: string = sessionCwd
      const rawArgs = Array.isArray(args.args) ? args.args : []
      const forwarded = sanitizeForwardedArgs(rawArgs)
      const requested = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS
      const timeout = Math.min(Math.max(requested, 1_000), MAX_TIMEOUT_MS)
      const subcommand: string = args.subcommand
      const run = await execAoci(binary, ['--json', subcommand, ...forwarded], cwd, timeout)
      const code = run.error === null || run.error.code === undefined ? 0 : Number(run.error.code)
      const out = truncate(run.stdout)
      const err = truncate(run.stderr)
      if (run.error !== null && code === 0) {
        return { status: 'error', exitCode: 1, stdout: out, stderr: `${err}\n${run.error.message}` } satisfies AociToolResult
      }
      return { status: code === 0 ? 'ok' : 'error', exitCode: code, stdout: out, stderr: err } satisfies AociToolResult
    },
  })
}
