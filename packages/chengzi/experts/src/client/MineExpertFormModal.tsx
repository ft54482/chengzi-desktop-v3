import { useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ExpertDef } from '../expert-types.js'
import type { MineExpertInput } from '../mine-types.js'
import { MINE_ALLOWED_TOOLS, MINE_LIMITS } from '../mine-types.js'

/** 图标选择器的预置 emoji（全部为单字符/基础 emoji + 变体选择符）。 */
const ICON_PRESETS: readonly string[] = Object.freeze([
  '🤖', '✍️', '📊', '🎨', '🎬', '💻', '📚', '🧠', '💡', '🎯', '🔧', '🧭', '🌱', '📣', '🗂️', '⚡',
])

/** 工具勾选的展示标签（付费项标注单价，与专家目录黄字口径一致）。 */
const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  generate_hzcfjt_ppt: '生成 PPT（免费）',
  generate_image: 'AI 配图（¥0.20/张）',
  generate_video: 'AI 视频（¥1.20/次）',
})

type FieldKey = 'name' | 'icon' | 'description' | 'persona' | 'starters' | 'costHint'

type FieldErrors = Partial<Record<FieldKey, string>>

interface FormState {
  readonly name: string
  readonly icon: string
  readonly description: string
  readonly persona: string
  readonly tools: readonly string[]
  readonly starters: readonly string[]
  readonly costHint: string
}

function initialState(expert?: ExpertDef): FormState {
  return {
    name: expert?.name ?? '',
    icon: expert?.icon ?? '🤖',
    description: expert?.description ?? '',
    persona: expert?.persona ?? '',
    tools: expert === undefined ? [] : [...expert.tools].filter(tool => MINE_ALLOWED_TOOLS.includes(tool)),
    starters: expert === undefined ? [''] : [...expert.starter_prompts, ''].slice(0, MINE_LIMITS.starterPrompts + 1),
    costHint: expert?.cost_hint ?? '',
  }
}

function validate(state: FormState): FieldErrors {
  const errors: FieldErrors = {}
  const name = state.name.trim()
  if (name.length === 0) errors.name = '请填写专家名称'
  else if (name.length > MINE_LIMITS.name) errors.name = `名称不超过 ${String(MINE_LIMITS.name)} 个字`
  if (state.icon.length === 0) errors.icon = '请选择一个图标'
  const description = state.description.trim()
  if (description.length > MINE_LIMITS.description) errors.description = `描述不超过 ${String(MINE_LIMITS.description)} 个字`
  const persona = state.persona.trim()
  if (persona.length === 0) errors.persona = '请填写人格提示词'
  else if (persona.length > MINE_LIMITS.persona) errors.persona = `人格提示词不超过 ${String(MINE_LIMITS.persona)} 个字`
  const filled = state.starters.map(prompt => prompt.trim()).filter(prompt => prompt.length > 0)
  if (filled.length > MINE_LIMITS.starterPrompts) errors.starters = `示例问题最多 ${String(MINE_LIMITS.starterPrompts)} 条`
  else if (filled.some(prompt => prompt.length > MINE_LIMITS.starterPrompt)) {
    errors.starters = `每条示例问题不超过 ${String(MINE_LIMITS.starterPrompt)} 个字`
  }
  if (state.costHint.trim().length > MINE_LIMITS.costHint) errors.costHint = `费用提示不超过 ${String(MINE_LIMITS.costHint)} 个字`
  return errors
}

function toInput(state: FormState): MineExpertInput {
  return {
    name: state.name.trim(),
    icon: state.icon,
    description: state.description.trim(),
    persona: state.persona.trim(),
    tools: [...state.tools],
    starter_prompts: state.starters.map(prompt => prompt.trim()).filter(prompt => prompt.length > 0),
    cost_hint: state.costHint.trim(),
  }
}

/**
 * 「创建/编辑我的专家」表单 Modal：行内红字校验 + emoji 图标选择 +
 * 工具勾选（付费项标价）。提交由父组件调用 host 路由，busy/error 受控。
 */
export function MineExpertFormModal({ expert, busy, error, onCancel, onSubmit }: {
  /** 编辑时的预填专家；缺省为创建模式。 */
  expert?: ExpertDef | undefined
  /** 提交进行中（禁用按钮）。 */
  busy: boolean
  /** host 返回的表单级错误（显示在页脚上方）。 */
  error?: string | undefined
  onCancel: () => void
  onSubmit: (input: MineExpertInput) => void
}): ReactNode {
  const [state, setState] = useState<FormState>((): FormState => initialState(expert))
  const [errors, setErrors] = useState<FieldErrors>({})
  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setState(previous => ({ ...previous, [key]: value }))
  }

  const submit = (): void => {
    const found = validate(state)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    onSubmit(toInput(state))
  }

  const toggleTool = (tool: string): void => {
    set('tools', state.tools.includes(tool)
      ? state.tools.filter(entry => entry !== tool)
      : [...state.tools, tool])
  }

  const setStarter = (index: number, value: string): void => {
    set('starters', state.starters.map((prompt, i) => (i === index ? value : prompt)))
  }

  const fieldError = (key: FieldKey): string | undefined =>
    errors[key] === undefined && error === undefined ? undefined : errors[key]

  return (
    <Modal
      open
      onClose={() => { if (!busy) onCancel() }}
      title={expert === undefined ? '创建我的专家' : `编辑「${expert.name}」`}
      closeLabel="关闭表单"
      contentClassName="chengziMineForm"
      {...(expert === undefined ? { description: '设定名称、人格与工具，保存后出现在「我的」分区' } : {})}
      footer={(
        <>
          {error !== undefined && <p className="chengziMineFormError" role="alert">{error}</p>}
          <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={submit}>
            {busy ? '正在保存…' : expert === undefined ? '创建' : '保存'}
          </Button>
        </>
      )}
    >
      <div className="chengziMineField">
        <label className="chengziMineLabel" htmlFor="chengzi-mine-name">名称 <span className="chengziMineRequired">*</span></label>
        <Input
          id="chengzi-mine-name"
          className="chengziMineInput"
          value={state.name}
          maxLength={MINE_LIMITS.name}
          placeholder="例如：周报助手"
          disabled={busy}
          onChange={(event) => { set('name', event.target.value) }}
        />
        {fieldError('name') !== undefined && <p className="chengziMineFieldError">{errors.name}</p>}
      </div>

      <div className="chengziMineField">
        <span className="chengziMineLabel">图标 <span className="chengziMineRequired">*</span></span>
        <div className="chengziMineIcons" role="radiogroup" aria-label="选择图标">
          {ICON_PRESETS.map(emoji => (
            <button
              key={emoji}
              type="button"
              role="radio"
              aria-checked={state.icon === emoji}
              className="chengziMineIcon"
              data-active={state.icon === emoji}
              disabled={busy}
              onClick={() => { set('icon', emoji) }}
            >
              {emoji}
            </button>
          ))}
        </div>
        {fieldError('icon') !== undefined && <p className="chengziMineFieldError">{errors.icon}</p>}
      </div>

      <div className="chengziMineField">
        <label className="chengziMineLabel" htmlFor="chengzi-mine-desc">一句话描述</label>
        <Input
          id="chengzi-mine-desc"
          className="chengziMineInput"
          value={state.description}
          maxLength={MINE_LIMITS.description}
          placeholder="一句话说明这位专家擅长什么（选填）"
          disabled={busy}
          onChange={(event) => { set('description', event.target.value) }}
        />
        {fieldError('description') !== undefined && <p className="chengziMineFieldError">{errors.description}</p>}
      </div>

      <div className="chengziMineField">
        <label className="chengziMineLabel" htmlFor="chengzi-mine-persona">人格提示词 <span className="chengziMineRequired">*</span></label>
        <textarea
          id="chengzi-mine-persona"
          className="chengziMineTextarea"
          rows={7}
          value={state.persona}
          maxLength={MINE_LIMITS.persona}
          placeholder={'例如：\n你是「周报助手」，帮助用户把零散记录整理成结构化周报。\n工作方式：1. 先确认本周要点；2. 按进展/风险/计划三段输出；3. 语气简洁、多用列表。'}
          disabled={busy}
          onChange={(event) => { set('persona', event.target.value) }}
        />
        <p className="chengziMineHint">{String(state.persona.length)}/{String(MINE_LIMITS.persona)}</p>
        {fieldError('persona') !== undefined && <p className="chengziMineFieldError">{errors.persona}</p>}
      </div>

      <div className="chengziMineField">
        <span className="chengziMineLabel">工具</span>
        <div className="chengziMineTools">
          {MINE_ALLOWED_TOOLS.map(tool => (
            <label key={tool} className="chengziMineTool">
              <input
                type="checkbox"
                checked={state.tools.includes(tool)}
                disabled={busy}
                onChange={() => { toggleTool(tool) }}
              />
              <span>{TOOL_LABELS[tool] ?? tool}</span>
            </label>
          ))}
        </div>
        <p className="chengziMineHint">勾选后专家具备对应能力；付费工具执行前会先经用户确认费用</p>
      </div>

      <div className="chengziMineField">
        <span className="chengziMineLabel">示例问题（最多 {String(MINE_LIMITS.starterPrompts)} 条）</span>
        {state.starters.map((prompt, index) => (
          <div key={index} className="chengziMineStarterRow">
            <Input
              className="chengziMineInput"
              value={prompt}
              maxLength={MINE_LIMITS.starterPrompt}
              placeholder="例如：帮我把今天的会议记录整理成周报"
              disabled={busy}
              onChange={(event) => { setStarter(index, event.target.value) }}
            />
            <button
              type="button"
              className="chengziMineStarterRemove"
              aria-label={`删除示例问题 ${String(index + 1)}`}
              disabled={busy}
              onClick={() => { set('starters', state.starters.filter((_, i) => i !== index)) }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
        {state.starters.length < MINE_LIMITS.starterPrompts && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { set('starters', [...state.starters, '']) }}>
            + 添加示例问题
          </Button>
        )}
        {fieldError('starters') !== undefined && <p className="chengziMineFieldError">{errors.starters}</p>}
      </div>

      <div className="chengziMineField">
        <label className="chengziMineLabel" htmlFor="chengzi-mine-cost">费用提示（选填）</label>
        <Input
          id="chengzi-mine-cost"
          className="chengziMineInput"
          value={state.costHint}
          maxLength={MINE_LIMITS.costHint}
          placeholder="留空则卡片不显示费用黄字"
          disabled={busy}
          onChange={(event) => { set('costHint', event.target.value) }}
        />
        {fieldError('costHint') !== undefined && <p className="chengziMineFieldError">{errors.costHint}</p>}
      </div>
    </Modal>
  )
}
