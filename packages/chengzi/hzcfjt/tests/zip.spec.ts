import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { buildZip } from '../src/pptx/zip.js'

const run = promisify(execFile)

describe('buildZip', () => {
  it('produces a zip whose entries round-trip through the central directory', async () => {
    const entries = [
      { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>') },
      { name: 'ppt/slides/slide1.xml', data: Buffer.from('<p:sld>内容</p:sld>') },
    ]
    const archive = buildZip(entries)
    expect(archive.subarray(0, 2).toString('latin1')).toBe('PK')

    // 用 Python zipfile 读回验证（OOXML 消费者同源），失败时输出诊断
    const dir = await mkdtemp(join(tmpdir(), 'hzcfjt-zip-'))
    const path = join(dir, 'sample.zip')
    await writeFile(path, archive)
    const result = await run('python', ['-c', [
      'import zipfile,sys',
      'z=zipfile.ZipFile(sys.argv[1])',
      'bad=z.testzip()',
      'assert bad is None, bad',
      'names=z.namelist()',
      'assert names[0]=="[Content_Types].xml", names',
      'assert "ppt/slides/slide1.xml" in names',
      'data=z.read("ppt/slides/slide1.xml").decode("utf-8")',
      'assert "内容" in data',
      'print("zip-ok")',
    ].join('\n'), path])
    expect(result.stdout).toContain('zip-ok')
  })

  it('rejects backslash and absolute entry names', () => {
    expect(() => buildZip([{ name: 'ppt\\bad.xml', data: Buffer.from('x') }])).toThrow(/invalid zip entry/)
    expect(() => buildZip([{ name: '/abs.xml', data: Buffer.from('x') }])).toThrow(/invalid zip entry/)
  })
})
