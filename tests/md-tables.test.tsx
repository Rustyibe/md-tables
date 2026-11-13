import { expect, test } from 'claude-code/testing'

const BLOCK = (text: string, columns = 120) =>
  ({
    plugin: 'md-tables',
    component: 'AssistantMessage',
    requestId: 'm1',
    surface: 'terminal',
    viewport: { columns, rows: 40 },
    props: { text, isFirstOfReply: true },
  }) as const

test('a CJK table draws at true widths, inline code without backticks', async $ => {
  const ui = await $.ui.mount(
    BLOCK(
      [
        '| 套餐 | 可用模型 | 状态 |',
        '| --- | --- | --- |',
        '| 智谱 | `GLM-5.1` | 使用中 |',
      ].join('\n'),
    ),
  )

  // The bug this mod fixes: the cell broke to one glyph per line.
  expect((await ui.find({ type: 'Text', text: '使用中' }))?.text).toBe('使用中')
  expect((await ui.find({ type: 'Text', text: 'GLM-5.1' }))?.text).toBe('GLM-5.1')
  expect((await ui.find({ type: 'Text', text: /`/ }))?.text).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^┌─+┬─+┬─+┐$/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: '│' }))?.text).toBe('│')
  await ui.unmount()
})

test('two tables with no blank line between them draw as two grids', async $ => {
  const ui = await $.ui.mount(
    BLOCK(
      [
        '| A | B |',
        '| --- | --- |',
        '| 一 | 二 |',
        '| C | D |',
        '| --- | --- |',
        '| 三 | 四 |',
      ].join('\n'),
    ),
  )

  // The second table is drawn, not spat out raw: no line of ASCII pipes.
  expect((await ui.find({ type: 'Text', text: /三/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /\|.*\|/ }))?.text).toBeUndefined()
  await ui.unmount()
})

test('a block holding no table reaches the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine drawing</Text>
  })

  const ui = await $.ui.mount(BLOCK('just prose, and a `code` span, no table'))

  expect((await ui.find({ type: 'Text', text: /engine drawing/ }))?.text).toBe('engine drawing')
  await ui.unmount()
})

test('a table still at the block end streams raw while the turn is open', async ($, on) => {
  // openTurn stands true mid-stream: the last row may still grow, so the
  // grid waits and the source lines append as written.
  on('state.get', () => ({ value: { value: true, version: 1 } }))

  const ui = await $.ui.mount(
    BLOCK(
      [
        '| 项 | A |',
        '| --- | --- |',
        '| 值 | 一 |',
      ].join('\n'),
    ),
  )

  expect((await ui.find({ type: 'Text', text: '| 值 | 一 |' }))?.text).toBe('| 值 | 一 |')
  expect((await ui.find({ type: 'Text', text: /^[┌├└]/ }))?.text).toBeUndefined()
  await ui.unmount()
})

test('the same table grids at once once a blank line settles it', async ($, on) => {
  on('state.get', () => ({ value: { value: true, version: 1 } }))

  const ui = await $.ui.mount(
    BLOCK(
      [
        '| 项 | A |',
        '| --- | --- |',
        '| 值 | 一 |',
        '',
        'tail prose after the blank line',
      ].join('\n'),
    ),
  )

  expect((await ui.find({ type: 'Text', text: /值/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^┌─+┬─+┐$/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /\| 值/ }))?.text).toBeUndefined()
  await ui.unmount()
})

test('a too-narrow terminal wraps cells instead of breaking the grid', async $ => {
  // pi's allocation, not truncation: budget 27 seats 4 columns (overhead 13),
  // every column keeps at least its longest unbreakable unit (2 for CJK),
  // and the leftover cells go to the columns with the most growth room.
  const ui = await $.ui.mount(
    BLOCK(
      [
        '| 项目 | 说明 | 状态 | 备注 |',
        '| --- | --- | --- | --- |',
        '| 智谱 | 一个很长的关于模型能力的中文描述 | 使用中 | 好 |',
      ].join('\n'),
      30,
    ),
  )

  // allocation: forCells 14 over minimums [2,2,2,2] grows the wide column
  // mostly — widths land [3,7,2,2]. 智谱 (4) wraps to 智/谱; 好 (2) fits.
  expect((await ui.find({ type: 'Text', text: /^┌─+┬─+┬─+┬─+┐$/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /好/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /智/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /\.\.\./ }))?.text).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /\|.*\|/ }))?.text).toBeUndefined()
  await ui.unmount()
})

test('emoji cells count at their true width, rows keep the frame', async $ => {
  // The last drift: ✅ and ⚠️ measured 1, painted 2 — body lines ran past the
  // ┤. pi's tables now carry them: U+2705 in the wide ranges, U+26A0 through
  // its presentation selector as RGI emoji.
  const ui = await $.ui.mount(
    BLOCK(
      [
        '| 服务 | 健康度 |',
        '| --- | --- |',
        '| api-gateway | ✅ |',
        '| order-service | ⚠️ |',
      ].join('\n'),
    ),
  )

  expect((await ui.find({ type: 'Text', text: /✅/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /⚠️/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^│ api-gateway/ }))?.text).toBeDefined()
  await ui.unmount()
})
